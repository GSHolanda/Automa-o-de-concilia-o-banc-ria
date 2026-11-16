import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, createTenant, loggedIn, userWithRole, type ApiClient, type TestTenant } from '../helpers/app';
import { closePools, ownerPool } from '../helpers/db';
import {
  json,
  startLocalSmtpServer,
  startLocalTestServer,
  type LocalSmtpServer,
  type LocalTestServer,
} from '../helpers/fake-servers';
import { createBankAccount, drainJobs, makeJobsDue } from '../helpers/imports';
import { importLedger, runReconciliation } from '../helpers/reconciliation';

// Webhook e SMTP contra servidores locais de teste (127.0.0.1), identificados como tal. Nada é enviado para fora.
const SECRET = 'segredo-assinatura-ficticio-55aa';

let app: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;
let admin: ApiClient;
let otherAdmin: ApiClient;
let analyst: ApiClient & { userId: string };
let hook: LocalTestServer;
let smtp: LocalSmtpServer;
let webhookId: string;

async function deliveriesOf(event: string): Promise<any[]> {
  const result = await ownerPool().query(
    `SELECT * FROM notification_deliveries WHERE tenant_id = $1 AND event = $2 ORDER BY created_at`,
    [tenant.tenantId, event],
  );
  return result.rows;
}

function verifySignature(request: { headers: Record<string, unknown>; body: string }): boolean {
  const timestamp = String(request.headers['x-concilia-timestamp']);
  const expected = createHmac('sha256', SECRET).update(`${timestamp}.${request.body}`).digest('hex');
  return request.headers['x-concilia-signature'] === `sha256=${expected}`;
}

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'avisos' });
  other = await createTenant({ label: 'avisos-outra' });
  admin = await loggedIn(app, tenant.adminEmail);
  otherAdmin = await loggedIn(app, other.adminEmail);
  analyst = await userWithRole(app, admin, 'analista');
  hook = await startLocalTestServer((_request, res) => json(res, 200, { recebido: true }));
  smtp = await startLocalSmtpServer();
});

afterAll(async () => {
  await hook.close();
  await smtp.close();
  await app.close();
  await closePools();
});

describe('regras de notificação', () => {
  it('regra de webhook exige o módulo e uma integração de webhook da própria empresa', async () => {
    const blocked = await admin.post('/notification-rules', { event: 'import.completed', channel: 'webhook' });
    expect(blocked.status).toBe(403);

    expect((await admin.put('/modules/notifications.webhook', { enabled: true })).status).toBe(200);
    const integration = await admin.post('/integrations', {
      kind: 'webhook',
      name: 'Gancho local de teste',
      config: { url: `${hook.url}/eventos` },
      secret: SECRET,
    });
    webhookId = integration.body.id;
    expect((await admin.post('/notification-rules', { event: 'import.completed', channel: 'webhook' })).status).toBe(400);
    expect(
      (await admin.post('/notification-rules', { event: 'evento.inexistente', channel: 'webhook', integrationId: webhookId })).status,
    ).toBe(400);

    // Integração de outra empresa não existe para esta.
    expect((await otherAdmin.put('/modules/notifications.webhook', { enabled: true })).status).toBe(200);
    const foreign = await otherAdmin.post('/notification-rules', { event: 'import.completed', channel: 'webhook', integrationId: webhookId });
    expect(foreign.status).toBe(400);

    const rule = await admin.post('/notification-rules', { event: 'import.completed', channel: 'webhook', integrationId: webhookId });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    expect(rule.body).toMatchObject({ event: 'import.completed', channel: 'webhook', integrationId: webhookId, active: true });
    const listed = await admin.get('/notification-rules');
    expect(listed.body.items.map((item: { id: string }) => item.id)).toContain(rule.body.id);
    expect((await otherAdmin.get('/notification-rules')).body.items).toHaveLength(0);
    expect((await otherAdmin.patch(`/notification-rules/${rule.body.id}`, { active: false })).status).toBe(404);
  });

  it('regra interna exige papéis existentes; exige settings.manage', async () => {
    expect(
      (await admin.post('/notification-rules', { event: 'import.failed', channel: 'in_app', target: { roleKeys: ['papel-inexistente'] } }))
        .status,
    ).toBe(400);
    const ok = await admin.post('/notification-rules', { event: 'import.failed', channel: 'in_app', target: { roleKeys: ['analista'] } });
    expect(ok.status).toBe(201);
    expect((await analyst.get('/notification-rules')).status).toBe(403);
  });
});

describe('entrega por webhook contra servidor HTTP local de teste', () => {
  it('fim de importação → trabalho notification.deliver → POST assinado e registro sent', async () => {
    const before = hook.requests.length;
    await importLedger(app, admin, [{ date: '10/05/2024', description: 'FORNECEDOR FICTICIO', amount: '-100,00' }]);
    const sent = hook.requests.slice(before).filter((request) => request.headers['x-concilia-event'] === 'import.completed');
    expect(sent).toHaveLength(1);
    expect(verifySignature(sent[0]!)).toBe(true);
    const body = JSON.parse(sent[0]!.body);
    expect(body).toMatchObject({ event: 'import.completed', data: { status: 'completed', sourceKind: 'ledger' } });
    expect(sent[0]!.body).not.toContain(SECRET);

    const deliveries = await deliveriesOf('import.completed');
    const last = deliveries.at(-1);
    expect(last).toMatchObject({ status: 'sent', attempts: 1, response_status: 200, error: null, channel: 'webhook' });
    expect(last.sent_at).not.toBeNull();
    expect(body.id).toBe(last.id);

    const listed = await admin.get('/notification-deliveries?event=import.completed');
    expect(listed.status).toBe(200);
    expect(listed.body.items[0]).toMatchObject({ id: last.id, status: 'sent', responseStatus: 200 });
    expect((await otherAdmin.get('/notification-deliveries')).body.items).toHaveLength(0);
  });

  it('resposta não 2xx grava failed com o motivo; nova tentativa com sucesso grava sent', async () => {
    hook.respond((_request, res) => json(res, 503, { erro: 'indisponível' }));
    await importLedger(app, admin, [{ date: '11/05/2024', description: 'FORNECEDOR B', amount: '-50,00' }]);
    let last = (await deliveriesOf('import.completed')).at(-1);
    expect(last).toMatchObject({ status: 'failed', attempts: 1, response_status: 503 });
    expect(last.error).toContain('HTTP 503');

    hook.respond((_request, res) => json(res, 202, {}));
    await makeJobsDue();
    await drainJobs(app);
    last = (await deliveriesOf('import.completed')).at(-1);
    expect(last).toMatchObject({ status: 'sent', attempts: 2, response_status: 202, error: null });
  });

  it('falha definitiva: entrega failed, job.dead só como aviso interno (sem nova entrega externa)', async () => {
    const deadRule = await admin.post('/notification-rules', { event: 'job.dead', channel: 'webhook', integrationId: webhookId });
    expect(deadRule.status).toBe(201);
    hook.respond((_request, res) => json(res, 500, {}));
    await importLedger(app, admin, [{ date: '12/05/2024', description: 'FORNECEDOR C', amount: '-70,00' }]);
    for (let round = 0; round < 3; round += 1) {
      await makeJobsDue();
      await drainJobs(app);
    }
    const last = (await deliveriesOf('import.completed')).at(-1);
    expect(last).toMatchObject({ status: 'failed', attempts: 3 });
    const job = await ownerPool().query(`SELECT status FROM jobs WHERE type = 'notification.deliver' AND idempotency_key = $1`, [last.id]);
    expect(job.rows[0].status).toBe('dead');
    expect(await deliveriesOf('job.dead')).toHaveLength(0);
    const notices = await ownerPool().query(`SELECT user_id FROM notifications WHERE tenant_id = $1 AND event = 'job.dead'`, [
      tenant.tenantId,
    ]);
    expect(notices.rows.map((row) => row.user_id)).toContain(tenant.adminUserId);
    await admin.delete(`/notification-rules/${deadRule.body.id}`);
    hook.respond((_request, res) => json(res, 200, {}));
  });

  it('módulo desabilitado: a entrega fica skipped e nada é enviado', async () => {
    expect((await admin.put('/modules/notifications.webhook', { enabled: false })).status).toBe(200);
    try {
      const before = hook.requests.length;
      await importLedger(app, admin, [{ date: '13/05/2024', description: 'FORNECEDOR D', amount: '-80,00' }]);
      expect(hook.requests.length).toBe(before);
      expect((await deliveriesOf('import.completed')).at(-1)).toMatchObject({ status: 'skipped' });
      expect((await admin.get('/notification-rules')).status).toBe(200);
      expect((await admin.post('/notification-rules', { event: 'job.dead', channel: 'webhook', integrationId: webhookId })).status).toBe(403);
    } finally {
      await admin.put('/modules/notifications.webhook', { enabled: true });
    }
  });
});

describe('avisos internos', () => {
  it('regra in_app por papel, leitura e isolamento', async () => {
    const rule = await admin.post('/notification-rules', {
      event: 'reconciliation.completed',
      channel: 'in_app',
      target: { roleKeys: ['analista'] },
    });
    expect(rule.status).toBe(201);
    const account = await createBankAccount(tenant.tenantId, { name: 'Conta avisos' });
    await runReconciliation(app, admin, account.id, '2024-05-01', '2024-05-31');

    const mine = await analyst.get('/notifications');
    expect(mine.status).toBe(200);
    const notice = mine.body.items.find((item: { event: string }) => item.event === 'reconciliation.completed');
    expect(notice).toMatchObject({ title: 'Conciliação concluída', readAt: null, link: '/conciliacao' });
    expect(mine.body.unreadCount).toBeGreaterThanOrEqual(1);

    // Quem não recebeu não marca como lido.
    expect((await admin.post(`/notifications/${notice.id}/read`)).status).toBe(404);
    expect((await otherAdmin.post(`/notifications/${notice.id}/read`)).status).toBe(404);
    expect((await analyst.post(`/notifications/${notice.id}/read`)).status).toBe(204);
    const unread = await analyst.get('/notifications?unread=true');
    expect(unread.body.items.map((item: { id: string }) => item.id)).not.toContain(notice.id);
    expect((await analyst.post('/notifications/read-all')).status).toBe(204);
    expect((await analyst.get('/notifications')).body.unreadCount).toBe(0);
  });
});

describe('e-mail por SMTP contra servidor SMTP local de teste', () => {
  it('teste verificado e entrega registrada como sent', async () => {
    expect((await admin.put('/modules/notifications.email', { enabled: true })).status).toBe(200);
    const integration = await admin.post('/integrations', {
      kind: 'smtp',
      name: 'SMTP local de teste',
      config: { host: '127.0.0.1', port: smtp.port, secure: false, from: 'avisos@exemplo.test' },
    });
    expect(integration.status, JSON.stringify(integration.body)).toBe(201);
    const tested = await admin.post(`/integrations/${integration.body.id}/test`);
    expect(tested.body).toMatchObject({ status: 'verified' });

    const rule = await admin.post('/notification-rules', {
      event: 'import.completed',
      channel: 'email',
      integrationId: integration.body.id,
      target: { emails: ['financeiro@exemplo.test'] },
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    await importLedger(app, admin, [{ date: '14/05/2024', description: 'FORNECEDOR E', amount: '-90,00' }]);
    expect(smtp.messages.at(-1)!.to.join()).toContain('financeiro@exemplo.test');
    const emails = (await deliveriesOf('import.completed')).filter((row) => row.channel === 'email');
    expect(emails.at(-1)).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('CA-27: SMTP inalcançável fica error, nunca verified', async () => {
    const integration = await admin.post('/integrations', {
      kind: 'smtp',
      name: 'SMTP inalcançável',
      config: { host: '127.0.0.1', port: 1, from: 'avisos@exemplo.test' },
    });
    const tested = await admin.post(`/integrations/${integration.body.id}/test`);
    expect(tested.body.status).toBe('error');
    expect(tested.body.lastError).toMatch(/SMTP/);
  });
});
