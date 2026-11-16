import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/security/tokens';
import { buildTestApp, createTenant, loggedIn, userWithRole, type ApiClient, type TestTenant } from '../helpers/app';
import { closePools, ownerPool } from '../helpers/db';
import { createBankAccount, drainJobs, ledgerEntriesOf } from '../helpers/imports';

let app: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;
let admin: ApiClient;
let otherAdmin: ApiClient;
let token: string;
let tokenId: string;
let otherToken: string;

function send(method: 'GET' | 'POST', url: string, bearer: string | null, payload?: unknown, headers: Record<string, string> = {}) {
  return app
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    })
    .then((response) => ({ status: response.statusCode, body: response.json(), raw: response.body }));
}

const entries = (tag: string) => [
  { externalId: `API-${tag}-1`, date: '2024-06-03', amountCents: -12990, description: 'Fornecedor fictício', document: 'NF 1' },
  { externalId: `API-${tag}-2`, date: '2024-06-04', amountCents: 50000, description: 'Cliente fictício' },
];

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'api-entrada' });
  other = await createTenant({ label: 'api-entrada-outra' });
  admin = await loggedIn(app, tenant.adminEmail);
  otherAdmin = await loggedIn(app, other.adminEmail);
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('tokens de API', () => {
  it('exige o módulo api.inbound', async () => {
    const blocked = await admin.post('/api-tokens', { name: 'ERP' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('module_disabled');
    expect((await admin.get('/api-tokens')).status).toBe(403);
    for (const client of [admin, otherAdmin]) {
      expect((await client.put('/modules/api.inbound', { enabled: true })).status).toBe(200);
    }
  });

  it('cria (token exibido uma vez), lista só o prefixo e guarda apenas o hash', async () => {
    const created = await admin.post('/api-tokens', { name: 'ERP fictício', scopes: ['ledger:write'] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    token = created.body.token;
    tokenId = created.body.id;
    expect(token).toMatch(/^ck_/);
    expect(created.body).toMatchObject({ name: 'ERP fictício', scopes: ['ledger:write'], prefix: token.slice(0, 10) });

    const listed = await admin.get('/api-tokens');
    expect(listed.status).toBe(200);
    expect(listed.body.items[0]).toMatchObject({ id: tokenId, prefix: token.slice(0, 10), revokedAt: null });
    expect(listed.raw.toString()).not.toContain(token);

    const stored = await ownerPool().query('SELECT token_hash, token_prefix FROM api_tokens WHERE id = $1', [tokenId]);
    expect(Buffer.compare(stored.rows[0].token_hash, sha256(token))).toBe(0);
    const audit = await ownerPool().query(`SELECT count(*)::int AS total FROM audit_log WHERE after::text LIKE $1 OR metadata::text LIKE $1`, [
      `%${token}%`,
    ]);
    expect(audit.rows[0].total).toBe(0);

    otherToken = (await otherAdmin.post('/api-tokens', { name: 'ERP da outra' })).body.token;
  });

  it('exige integrations.manage', async () => {
    const analyst = await userWithRole(app, admin, 'analista');
    expect((await analyst.get('/api-tokens')).status).toBe(403);
  });
});

describe('API de entrada de lançamentos', () => {
  let batchId: string;

  it('sem token ou com token inválido responde 401', async () => {
    expect((await send('POST', '/integrations/ledger/entries', null, { entries: entries('x') }, { 'idempotency-key': 'k' })).status).toBe(401);
    expect(
      (await send('POST', '/integrations/ledger/entries', 'ck_invalido', { entries: entries('x') }, { 'idempotency-key': 'k' })).status,
    ).toBe(401);
  });

  it('exige Idempotency-Key', async () => {
    const missing = await send('POST', '/integrations/ledger/entries', token, { entries: entries('sem-chave') });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('idempotency_key_required');
  });

  it('valida o lote: até 1.000 lançamentos em centavos inteiros', async () => {
    const invalid = await send(
      'POST',
      '/integrations/ledger/entries',
      token,
      { entries: [{ date: '2024-06-03', amountCents: 10.5, description: 'x' }] },
      { 'idempotency-key': 'invalido-1' },
    );
    expect(invalid.status).toBe(400);
    const tooMany = Array.from({ length: 1001 }, (_, index) => ({ date: '2024-06-03', amountCents: index + 1, description: 'x' }));
    expect((await send('POST', '/integrations/ledger/entries', token, { entries: tooMany }, { 'idempotency-key': 'muitos' })).status).toBe(400);
  });

  it('aceita o lote (202), cria lote de origem api e processa pelo pipeline de importação', async () => {
    const account = await createBankAccount(tenant.tenantId, { name: 'Conta API' });
    const key = `pedido-${randomBytes(4).toString('hex')}`;
    const accepted = await send(
      'POST',
      '/integrations/ledger/entries',
      token,
      { bankAccountId: account.id, entries: entries('a') },
      { 'idempotency-key': key },
    );
    expect(accepted.status, accepted.raw).toBe(202);
    batchId = accepted.body.batchId;
    expect(accepted.body.jobId).toBeTruthy();

    // Mesma chave e mesmo conteúdo: mesmo lote, sem novo trabalho.
    const replay = await send(
      'POST',
      '/integrations/ledger/entries',
      token,
      { bankAccountId: account.id, entries: entries('a') },
      { 'idempotency-key': key },
    );
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({ batchId, jobId: accepted.body.jobId, replayed: true });

    // Mesma chave com outro conteúdo: conflito.
    const reused = await send('POST', '/integrations/ledger/entries', token, { entries: entries('b') }, { 'idempotency-key': key });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('idempotency_key_reused');

    await drainJobs(app);
    const status = await send('GET', `/integrations/ledger/batches/${batchId}`, token);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ id: batchId, status: 'completed', stats: { imported: 2, rejected: 0 } });
    const stored = await ledgerEntriesOf(batchId);
    expect(stored.map((entry) => [entry.external_id, entry.amount_cents, entry.bank_account_id])).toEqual([
      [`API-a-1`, -12990, account.id],
      [`API-a-2`, 50000, account.id],
    ]);
    const batch = await admin.get(`/imports/${batchId}`);
    expect(batch.body).toMatchObject({ origin: 'api', fileFormat: 'json' });

    const audit = await admin.get(`/audit?entityId=${batchId}`);
    const received = audit.body.items.find((item: { action: string }) => item.action === 'import.api_received');
    expect(received).toMatchObject({ actorType: 'api_token' });

    const used = await ownerPool().query('SELECT last_used_at FROM api_tokens WHERE id = $1', [tokenId]);
    expect(used.rows[0].last_used_at).not.toBeNull();
  });

  it('o mesmo conteúdo com outra chave é recusado como arquivo duplicado', async () => {
    const account = await ownerPool().query('SELECT bank_account_id FROM import_batches WHERE id = $1', [batchId]);
    const duplicate = await send(
      'POST',
      '/integrations/ledger/entries',
      token,
      { bankAccountId: account.rows[0].bank_account_id, entries: entries('a') },
      { 'idempotency-key': 'outra-chave' },
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatchObject({ code: 'duplicate_file', details: { batchId } });
  });

  it('escopo: token sem ledger:write responde 403', async () => {
    const { generateApiToken } = await import('../../src/security/tokens');
    const generated = generateApiToken();
    await ownerPool().query(
      `INSERT INTO api_tokens (tenant_id, name, token_prefix, token_hash, scopes) VALUES ($1, 'Sem escopo', $2, $3, '{}')`,
      [tenant.tenantId, generated.prefix, sha256(generated.token)],
    );
    const refused = await send('POST', '/integrations/ledger/entries', generated.token, { entries: entries('c') }, { 'idempotency-key': 'e' });
    expect(refused.status).toBe(403);
  });

  it('isolamento: token de outra empresa não vê o lote (404) e cria lotes só na própria empresa', async () => {
    expect((await send('GET', `/integrations/ledger/batches/${batchId}`, otherToken)).status).toBe(404);
    const mine = await send('POST', '/integrations/ledger/entries', otherToken, { entries: entries('o') }, { 'idempotency-key': 'k-outra' });
    expect(mine.status).toBe(202);
    const row = await ownerPool().query('SELECT tenant_id FROM import_batches WHERE id = $1', [mine.body.batchId]);
    expect(row.rows[0].tenant_id).toBe(other.tenantId);
    // Conta bancária de outra empresa não é aceita.
    const foreign = await ownerPool().query('SELECT bank_account_id FROM import_batches WHERE id = $1', [batchId]);
    const refused = await send(
      'POST',
      '/integrations/ledger/entries',
      otherToken,
      { bankAccountId: foreign.rows[0].bank_account_id, entries: entries('p') },
      { 'idempotency-key': 'k-conta' },
    );
    expect(refused.status).toBe(400);
  });

  it('módulo desabilitado bloqueia a API de entrada', async () => {
    expect((await otherAdmin.put('/modules/api.inbound', { enabled: false })).status).toBe(200);
    const blocked = await send('POST', '/integrations/ledger/entries', otherToken, { entries: entries('q') }, { 'idempotency-key': 'k-mod' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('module_disabled');
    await otherAdmin.put('/modules/api.inbound', { enabled: true });
  });

  it('revogação: token revogado responde 401 imediatamente', async () => {
    expect((await admin.post(`/api-tokens/${tokenId}/revoke`)).status).toBe(204);
    const listed = await admin.get('/api-tokens');
    expect(listed.body.items.find((item: { id: string }) => item.id === tokenId).revokedAt).not.toBeNull();
    const refused = await send('POST', '/integrations/ledger/entries', token, { entries: entries('r') }, { 'idempotency-key': 'k-rev' });
    expect(refused.status).toBe(401);
    expect((await send('GET', `/integrations/ledger/batches/${batchId}`, token)).status).toBe(401);
    // Revogar token de outra empresa: 404.
    expect((await otherAdmin.post(`/api-tokens/${tokenId}/revoke`)).status).toBe(404);
  });
});
