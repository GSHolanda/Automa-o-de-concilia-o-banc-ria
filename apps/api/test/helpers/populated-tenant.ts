import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { createTenant, loggedIn, userWithRole, type ApiClient, type TestTenant } from './app';
import { createBankAccount } from './imports';
import { importLedger, importStatement, runReconciliation } from './reconciliation';

export interface PopulatedTenant extends TestTenant {
  admin: ApiClient;
  /** Segredo fictício da integração (para conferir que não vaza). */
  integrationSecret: string;
  /** Token de API fictício (para conferir que não vaza). */
  apiToken: string;
}

/**
 * Empresa fictícia com um pouco de tudo: usuários, configurações, conta, extrato e lançamentos importados,
 * conciliação executada, integração com segredo, token de API, sessões e trilha de auditoria.
 */
export async function populatedTenant(app: FastifyInstance, label: string): Promise<PopulatedTenant> {
  const tenant = await createTenant({ label });
  const admin = await loggedIn(app, tenant.adminEmail);
  await userWithRole(app, admin, 'analista');
  const settings = await admin.put('/settings', { patch: { branding: { primaryColor: '#123456' } } });
  expect(settings.status).toBe(200);

  const ref = `CC-${randomBytes(2).toString('hex')}`;
  const account = await createBankAccount(tenant.tenantId, { accountNumber: '33333-3', externalRef: ref });
  await importStatement(app, admin, account, [
    { date: '2024-04-02', amount: '-320,00', memo: 'PAGAMENTO FORNECEDOR FICTICIO' },
    { date: '2024-04-03', amount: '1500,00', memo: 'PIX RECEBIDO CLIENTE FICTICIO' },
  ]);
  await importLedger(app, admin, [
    { date: '02/04/2024', description: 'Fornecedor fictício', amount: '-320,00', account: ref },
    { date: '03/04/2024', description: 'Cliente fictício', amount: '1500,00', account: ref },
  ]);
  await runReconciliation(app, admin, account.id, '2024-04-01', '2024-04-30');

  for (const key of ['notifications.webhook', 'api.inbound']) {
    expect((await admin.put(`/modules/${key}`, { enabled: true })).status).toBe(200);
  }
  const integrationSecret = `segredo-ficticio-${randomBytes(6).toString('hex')}`;
  const integration = await admin.post('/integrations', {
    kind: 'webhook',
    name: 'Gancho fictício',
    config: { url: 'http://127.0.0.1:9/gancho' },
    secret: integrationSecret,
  });
  expect(integration.status, JSON.stringify(integration.body)).toBe(201);
  const token = await admin.post('/api-tokens', { name: 'ERP fictício', scopes: ['ledger:write'] });
  expect(token.status, JSON.stringify(token.body)).toBe(201);

  return { ...tenant, admin, integrationSecret, apiToken: token.body.token as string };
}
