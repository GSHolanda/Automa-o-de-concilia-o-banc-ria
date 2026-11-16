import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, createTenant, loggedIn, userWithRole, type ApiClient, type TestTenant } from '../helpers/app';
import { closePools, ownerPool } from '../helpers/db';
import { json, startLocalTestServer, UNREACHABLE_URL, type LocalTestServer } from '../helpers/fake-servers';
import { createBankAccount, drainJobs, ledgerEntriesOf } from '../helpers/imports';

// Integrações testadas contra servidores HTTP locais de teste (127.0.0.1), identificados como tal.
// Nenhum serviço externo real é chamado.
const WEBHOOK_SECRET = 'segredo-webhook-ficticio-9f8e7d';
const REST_SECRET = 'token-erp-ficticio-1a2b3c';

let app: FastifyInstance;
let strictApp: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;
let admin: ApiClient;
let otherAdmin: ApiClient;
let strictAdmin: ApiClient;
let hook: LocalTestServer;
let erp: LocalTestServer;

async function allSecretsAbsent(secret: string): Promise<void> {
  const audit = await ownerPool().query(
    `SELECT count(*)::int AS total FROM audit_log
      WHERE summary LIKE $1 OR before::text LIKE $1 OR after::text LIKE $1 OR metadata::text LIKE $1`,
    [`%${secret}%`],
  );
  expect(audit.rows[0].total).toBe(0);
  const stored = await ownerPool().query(
    `SELECT count(*)::int AS total FROM integrations
      WHERE config::text LIKE $1 OR coalesce(last_error, '') LIKE $1 OR position(convert_to($2, 'UTF8') in coalesce(secret_ciphertext, ''::bytea)) > 0`,
    [`%${secret}%`, secret],
  );
  expect(stored.rows[0].total).toBe(0);
  const deliveries = await ownerPool().query(
    `SELECT count(*)::int AS total FROM notification_deliveries WHERE coalesce(error, '') LIKE $1 OR payload::text LIKE $1`,
    [`%${secret}%`],
  );
  expect(deliveries.rows[0].total).toBe(0);
  const jobs = await ownerPool().query(
    `SELECT count(*)::int AS total FROM jobs WHERE coalesce(last_error, '') LIKE $1 OR payload::text LIKE $1 OR coalesce(result::text, '') LIKE $1`,
    [`%${secret}%`],
  );
  expect(jobs.rows[0].total).toBe(0);
}

beforeAll(async () => {
  app = await buildTestApp();
  strictApp = await buildTestApp({ ALLOW_PRIVATE_INTEGRATION_HOSTS: 'false' });
  tenant = await createTenant({ label: 'integra' });
  other = await createTenant({ label: 'integra-outra' });
  admin = await loggedIn(app, tenant.adminEmail);
  otherAdmin = await loggedIn(app, other.adminEmail);
  strictAdmin = await loggedIn(strictApp, tenant.adminEmail);
  hook = await startLocalTestServer();
  erp = await startLocalTestServer();
  for (const client of [admin, otherAdmin]) {
    for (const key of ['notifications.webhook', 'connector.rest']) {
      expect((await client.put(`/modules/${key}`, { enabled: true })).status).toBe(200);
    }
  }
});

afterAll(async () => {
  await hook.close();
  await erp.close();
  await app.close();
  await strictApp.close();
  await closePools();
});

describe('cadastro de integrações', () => {
  let webhookId: string;

  it('cria webhook: segredo só de escrita, resposta traz hasSecret e situação configured', async () => {
    const created = await admin.post('/integrations', {
      kind: 'webhook',
      name: 'Gancho local de teste',
      config: { url: `${hook.url}/gancho` },
      secret: WEBHOOK_SECRET,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ kind: 'webhook', hasSecret: true, status: 'configured', lastError: null });
    expect(created.raw.toString()).not.toContain(WEBHOOK_SECRET);
    webhookId = created.body.id;

    const listed = await admin.get('/integrations');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toContain(webhookId);
    expect(listed.raw.toString()).not.toContain(WEBHOOK_SECRET);
    const single = await admin.get(`/integrations/${webhookId}`);
    expect(single.body).toMatchObject({ id: webhookId, hasSecret: true, moduleEnabled: true });
    expect(single.raw.toString()).not.toContain(WEBHOOK_SECRET);
  });

  it('sem segredo obrigatório fica not_configured; configuração inválida é recusada', async () => {
    const missing = await admin.post('/integrations', { kind: 'webhook', name: 'Sem segredo', config: { url: `${hook.url}/x` } });
    expect(missing.status).toBe(201);
    expect(missing.body).toMatchObject({ hasSecret: false, status: 'not_configured' });
    const invalid = await admin.post('/integrations', { kind: 'webhook', name: 'Inválido', config: { url: 'nao-e-url' }, secret: 'x' });
    expect(invalid.status).toBe(400);
    const tested = await admin.post(`/integrations/${missing.body.id}/test`);
    expect(tested.body).toMatchObject({ status: 'error' });
    expect(tested.body.lastError).toMatch(/Segredo/);
  });

  it('teste real contra servidor HTTP local de teste: assinatura conferida e situação verified', async () => {
    hook.respond((_request, res) => json(res, 200, { ok: true }));
    const tested = await admin.post(`/integrations/${webhookId}/test`);
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ status: 'verified', lastError: null });
    expect(tested.body.lastCheckedAt).not.toBeNull();

    const request = hook.requests.at(-1)!;
    expect(request.headers['x-concilia-event']).toBe('integration.test');
    const timestamp = String(request.headers['x-concilia-timestamp']);
    const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${request.body}`).digest('hex');
    expect(request.headers['x-concilia-signature']).toBe(`sha256=${expected}`);
    expect(request.body).not.toContain(WEBHOOK_SECRET);
  });

  it('CA-27: resposta não 2xx ou destino inalcançável ficam error com mensagem, nunca verified', async () => {
    hook.respond((_request, res) => json(res, 500, { erro: 'falha' }));
    const failed = await admin.post(`/integrations/${webhookId}/test`);
    expect(failed.body).toMatchObject({ status: 'error' });
    expect(failed.body.lastError).toContain('HTTP 500');

    const unreachable = await admin.post('/integrations', {
      kind: 'webhook',
      name: 'Gancho inalcançável',
      config: { url: `${UNREACHABLE_URL}/gancho` },
      secret: WEBHOOK_SECRET,
    });
    const tested = await admin.post(`/integrations/${unreachable.body.id}/test`);
    expect(tested.status).toBe(200);
    expect(tested.body.status).toBe('error');
    expect(tested.body.lastError).toMatch(/conexão/i);
    const row = await ownerPool().query('SELECT status, last_error FROM integrations WHERE id = $1', [unreachable.body.id]);
    expect(row.rows[0].status).toBe('error');
    expect(row.rows[0].last_error).toBeTruthy();
  });

  it('alterar configuração ou segredo volta a configured (verified só depois de nova chamada real)', async () => {
    hook.respond((_request, res) => json(res, 204, null));
    expect((await admin.post(`/integrations/${webhookId}/test`)).body.status).toBe('verified');
    const patched = await admin.patch(`/integrations/${webhookId}`, { secret: `${WEBHOOK_SECRET}-novo` });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ status: 'configured', hasSecret: true });
    const renamed = await admin.patch(`/integrations/${webhookId}`, { name: 'Gancho renomeado' });
    expect(renamed.body).toMatchObject({ name: 'Gancho renomeado', status: 'configured' });
    const restored = await admin.patch(`/integrations/${webhookId}`, { secret: WEBHOOK_SECRET });
    expect(restored.body.hasSecret).toBe(true);
  });

  it('safeFetch na integração: sem liberação, endereço local é recusado e fica error', async () => {
    const created = await strictAdmin.post('/integrations', {
      kind: 'webhook',
      name: 'Gancho em endereço privado',
      config: { url: 'https://127.0.0.1:9/gancho' },
      secret: WEBHOOK_SECRET,
    });
    expect(created.status).toBe(201);
    const before = hook.requests.length;
    const tested = await strictAdmin.post(`/integrations/${created.body.id}/test`);
    expect(tested.body.status).toBe('error');
    expect(tested.body.lastError).toMatch(/Destino recusado/);
    expect(hook.requests.length).toBe(before);
  });

  it('CA-23: texto cifrado de uma empresa não decifra no contexto de outra', async () => {
    const mine = await ownerPool().query('SELECT secret_ciphertext FROM integrations WHERE id = $1', [webhookId]);
    const foreign = await otherAdmin.post('/integrations', {
      kind: 'webhook',
      name: 'Gancho da outra empresa',
      config: { url: `${hook.url}/outra` },
      secret: 'segredo-proprio-da-outra',
    });
    expect(foreign.status).toBe(201);
    // Simula cópia indevida do texto cifrado entre empresas, direto no banco.
    await ownerPool().query('UPDATE integrations SET secret_ciphertext = $2 WHERE id = $1', [
      foreign.body.id,
      mine.rows[0].secret_ciphertext,
    ]);
    hook.respond((_request, res) => json(res, 200, {}));
    const before = hook.requests.length;
    const tested = await otherAdmin.post(`/integrations/${foreign.body.id}/test`);
    expect(tested.body.status).toBe('error');
    expect(tested.body.lastError).toMatch(/decifrar/);
    expect(hook.requests.length).toBe(before);
  });

  it('isolamento: integração de outra empresa responde 404 e não aparece na lista', async () => {
    expect((await otherAdmin.get(`/integrations/${webhookId}`)).status).toBe(404);
    expect((await otherAdmin.post(`/integrations/${webhookId}/test`)).status).toBe(404);
    expect((await otherAdmin.patch(`/integrations/${webhookId}`, { name: 'x' })).status).toBe(404);
    const listed = await otherAdmin.get('/integrations');
    expect(listed.body.items.map((item: { id: string }) => item.id)).not.toContain(webhookId);
  });

  it('exige integrations.manage', async () => {
    const analyst = await userWithRole(app, admin, 'analista');
    expect((await analyst.get('/integrations')).status).toBe(403);
    expect((await analyst.post('/integrations', { kind: 'webhook', name: 'x', config: { url: hook.url } })).status).toBe(403);
  });

  it('módulo desabilitado bloqueia as rotas do tipo correspondente', async () => {
    const ai = await admin.post('/integrations', { kind: 'ai_provider', name: 'IA', config: { provider: 'anthropic' }, secret: 'x' });
    expect(ai.status).toBe(403);
    expect(ai.body.error.code).toBe('module_disabled');
    expect((await admin.put('/modules/notifications.webhook', { enabled: false })).status).toBe(200);
    try {
      const blocked = await admin.post(`/integrations/${webhookId}/test`);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('module_disabled');
      expect((await admin.patch(`/integrations/${webhookId}`, { name: 'y' })).status).toBe(403);
      const listed = await admin.get('/integrations');
      expect(listed.body.items.find((item: { id: string }) => item.id === webhookId).moduleEnabled).toBe(false);
    } finally {
      expect((await admin.put('/modules/notifications.webhook', { enabled: true })).status).toBe(200);
    }
  });

  it('exclui integração sem uso (204) e registra auditoria', async () => {
    const created = await admin.post('/integrations', { kind: 'webhook', name: 'Descartável', config: { url: hook.url }, secret: 'abc' });
    expect((await admin.delete(`/integrations/${created.body.id}`)).status).toBe(204);
    expect((await admin.get(`/integrations/${created.body.id}`)).status).toBe(404);
    const audit = await admin.get(`/audit?entityId=${created.body.id}`);
    expect(audit.body.items.map((item: { action: string }) => item.action)).toEqual(
      expect.arrayContaining(['integration.created', 'integration.deleted']),
    );
  });

  it('CA-23: segredo nunca aparece em auditoria, configuração ou last_error', async () => {
    await allSecretsAbsent(WEBHOOK_SECRET);
  });
});

describe('conector REST contra servidor HTTP local de teste', () => {
  let connectorId: string;
  let accountId: string;

  beforeAll(async () => {
    accountId = (await createBankAccount(tenant.tenantId, { name: 'Conta do conector' })).id;
  });

  it('teste com token Bearer e lista em itemsPath → verified', async () => {
    erp.respond((request, res) => {
      if (request.headers.authorization !== `Bearer ${REST_SECRET}`) {
        json(res, 401, { erro: `token recusado: ${String(request.headers.authorization)}` });
        return;
      }
      json(res, 200, {
        dados: {
          itens: [
            { id: 'ERP-1', data: '2024-05-10', valor: '-320.15', historico: 'Fornecedor Fictício', doc: 'NF 77' },
            { id: 'ERP-2', data: '11/05/2024', valor: 1500, historico: 'Cliente Fictício' },
            { id: 'ERP-3', data: 'ontem', valor: 'abc', historico: 'Ilegível' },
          ],
        },
      });
    });
    const created = await admin.post('/integrations', {
      kind: 'rest_ledger',
      name: 'ERP local de teste',
      config: {
        baseUrl: erp.url,
        path: '/api/lancamentos',
        authType: 'bearer',
        itemsPath: 'dados.itens',
        fieldMap: { date: 'data', amount: 'valor', description: 'historico', externalId: 'id', document: 'doc' },
        bankAccountId: accountId,
      },
      secret: REST_SECRET,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    connectorId = created.body.id;
    const tested = await admin.post(`/integrations/${connectorId}/test`);
    expect(tested.body, JSON.stringify(tested.body)).toMatchObject({ status: 'verified' });
    expect(erp.requests.at(-1)!.url).toMatch(/^\/api\/lancamentos\?dateFrom=\d{4}-\d{2}-\d{2}&dateTo=/);
  });

  it('pull → trabalho connector.pull → lote de origem connector processado pelo pipeline de importação', async () => {
    const pulled = await admin.post(`/integrations/${connectorId}/pull`, { dateFrom: '2024-05-01', dateTo: '2024-05-31' });
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(202);
    await drainJobs(app);
    const job = await admin.get(`/jobs?type=connector.pull`);
    const done = job.body.items.find((item: { id: string }) => item.id === pulled.body.jobId);
    expect(done.status).toBe('succeeded');
    const batchId = done.result.batchId as string;

    const batch = await admin.get(`/imports/${batchId}`);
    expect(batch.body).toMatchObject({ origin: 'connector', fileFormat: 'json', sourceKind: 'ledger', status: 'completed_with_errors' });
    expect(batch.body.stats).toMatchObject({ totalRows: 3, imported: 2, rejected: 1 });
    const entries = await ledgerEntriesOf(batchId);
    expect(entries.map((entry) => [entry.external_id, entry.entry_date, entry.amount_cents, entry.bank_account_id])).toEqual([
      ['ERP-1', '2024-05-10', -32015, accountId],
      ['ERP-2', '2024-05-11', 150000, accountId],
    ]);
    const rejections = await admin.get(`/imports/${batchId}/rejections`);
    expect(rejections.body.items).toHaveLength(1);
    expect(rejections.body.items[0].rowNumber).toBe(3);
    expect(erp.requests.at(-1)!.url).toContain('dateFrom=2024-05-01&dateTo=2024-05-31');
  });

  it('falha do serviço: last_error sem o segredo, mesmo quando a resposta ecoa o token', async () => {
    erp.respond((request, res) => json(res, 500, { erro: `falhou para ${String(request.headers.authorization)}` }));
    const tested = await admin.post(`/integrations/${connectorId}/test`);
    expect(tested.body.status).toBe('error');
    expect(tested.body.lastError).toContain('HTTP 500');
    expect(tested.raw.toString()).not.toContain(REST_SECRET);
    await allSecretsAbsent(REST_SECRET);
  });

  it('pull exige o módulo connector.rest e respeita isolamento', async () => {
    expect((await otherAdmin.post(`/integrations/${connectorId}/pull`, { dateFrom: '2024-05-01', dateTo: '2024-05-31' })).status).toBe(404);
    expect((await admin.put('/modules/connector.rest', { enabled: false })).status).toBe(200);
    try {
      const blocked = await admin.post(`/integrations/${connectorId}/pull`, { dateFrom: '2024-05-01', dateTo: '2024-05-31' });
      expect(blocked.status).toBe(403);
    } finally {
      await admin.put('/modules/connector.rest', { enabled: true });
    }
    const inverted = await admin.post(`/integrations/${connectorId}/pull`, { dateFrom: '2024-05-31', dateTo: '2024-05-01' });
    expect(inverted.status).toBe(400);
  });
});
