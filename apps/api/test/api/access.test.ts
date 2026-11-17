import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, buildTestApp, createTenant, loggedIn, userWithRole, TEST_PASSWORD, type TestTenant } from '../helpers/app';
import { closePools } from '../helpers/db';
import { createBankAccount } from '../helpers/imports';
import { importLedger, importStatement } from '../helpers/reconciliation';

// Revisão de segurança, achado 6: quem gerencia usuários não amplia o próprio acesso nem contorna os quatro olhos.
let app: FastifyInstance;
let tenant: TestTenant;
let admin: ApiClient;
let people: ApiClient & { email: string; userId: string };
let peopleRoleId: string;
let adminRoleId: string;
let gestorRoleId: string;

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'acesso' });
  admin = await loggedIn(app, tenant.adminEmail);
  const created = await admin.post('/roles', { key: 'pessoas', name: 'Gestão de pessoas', permissions: ['users.manage'] });
  expect(created.status).toBe(201);
  peopleRoleId = created.body.id;
  people = await userWithRole(app, admin, 'pessoas');
  const roles = (await admin.get('/roles')).body.items as { id: string; key: string }[];
  adminRoleId = roles.find((role) => role.key === 'admin')!.id;
  gestorRoleId = roles.find((role) => role.key === 'gestor')!.id;
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('users.manage não concede o que não tem', () => {
  it('não cria papel com permissão que o autor não tem; com subconjunto, cria', async () => {
    const all = await people.post('/roles', {
      key: 'tudo',
      name: 'Tudo',
      permissions: ['users.manage', 'integrations.manage', 'settings.manage'],
    });
    expect(all.status).toBe(403);
    expect(all.body.error.code).toBe('permission_escalation');
    const subset = await people.post('/roles', { key: 'pessoas-2', name: 'Pessoas 2', permissions: ['users.manage'] });
    expect(subset.status).toBe(201);
  });

  it('não amplia papel existente, nem o próprio', async () => {
    const widened = await people.patch(`/roles/${peopleRoleId}`, { permissions: ['users.manage', 'integrations.manage'] });
    expect(widened.status).toBe(403);
    expect(widened.body.error.code).toBe('permission_escalation');
    expect((await people.get('/integrations')).status).toBe(403);
  });

  it('não altera o próprio papel nem a própria situação', async () => {
    const promoted = await people.patch(`/users/${people.userId}`, { roleId: adminRoleId });
    expect(promoted.status).toBe(403);
    expect(promoted.body.error.code).toBe('self_access');
    const disabled = await people.patch(`/users/${people.userId}`, { status: 'disabled' });
    expect(disabled.status).toBe(403);
    expect((await people.patch(`/users/${people.userId}`, { name: 'Novo nome' })).status).toBe(200);
    // Vale também para o administrador.
    const self = await admin.patch(`/users/${tenant.adminUserId}`, { roleId: gestorRoleId });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_access');
  });

  it('não atribui papel mais forte a outra pessoa nem cria usuário com ele', async () => {
    const accomplice = await people.post('/users', { name: 'Cúmplice', email: `cumplice-${Date.now()}@exemplo.test`, roleId: adminRoleId });
    expect(accomplice.status).toBe(403);
    expect(accomplice.body.error.code).toBe('permission_escalation');
    const peer = await people.post('/users', {
      name: 'Par',
      email: `par-${Date.now()}@exemplo.test`,
      roleId: peopleRoleId,
      password: TEST_PASSWORD,
    });
    expect(peer.status).toBe(201);
    const raised = await people.patch(`/users/${peer.body.id}`, { roleId: gestorRoleId });
    expect(raised.status).toBe(403);
    expect(raised.body.error.code).toBe('permission_escalation');
  });

  it('não redefine a senha, não desativa e não derruba sessões de quem tem mais permissões', async () => {
    const reset = await people.post(`/users/${tenant.adminUserId}/reset-password`);
    expect(reset.status).toBe(403);
    expect(reset.body.error.code).toBe('permission_escalation');
    expect(reset.body.temporaryPassword).toBeUndefined();
    expect((await people.patch(`/users/${tenant.adminUserId}`, { status: 'disabled' })).status).toBe(403);
    expect((await people.post(`/users/${tenant.adminUserId}/revoke-sessions`)).status).toBe(403);
    // O administrador continua entrando com a própria senha.
    expect((await new ApiClient(app).login(tenant.adminEmail, TEST_PASSWORD)).status).toBe(200);
  });
});

describe('achado 11: descoberta de e-mail de outra empresa por POST /users', () => {
  it('tentativas de criação são limitadas por sessão (inclusive as recusadas por e-mail em uso)', async () => {
    const limited = await buildTestApp({ RATE_LIMIT_ENABLED: 'true' });
    try {
      const other = await createTenant({ label: 'acesso-outra' });
      const client = await loggedIn(limited, tenant.adminEmail);
      const statuses: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        const response = await client.post('/users', { name: 'Sondagem', email: other.adminEmail, roleId: gestorRoleId });
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 20).every((status) => status === 409)).toBe(true);
      expect(statuses[20]).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('quatro olhos com conta criada ou alterada por quem propôs', () => {
  let accountItems: { bank: any[]; ledger: any[] };
  let earlierManager: ApiClient & { email: string; userId: string };

  beforeAll(async () => {
    expect((await admin.put('/modules/approvals', { enabled: true })).status).toBe(200);
    expect((await admin.put('/settings', { patch: { approvals: { enabled: true, fourEyes: true } } })).status).toBe(200);
    earlierManager = await userWithRole(app, admin, 'gestor');
    const account = await createBankAccount(tenant.tenantId, { name: 'Conta Acesso', accountNumber: '4321-0', externalRef: 'CC-AC' });
    const bank = await importStatement(app, admin, account, [
      { date: '2024-07-02', amount: '-410.00', memo: 'PAGAMENTO UM' },
      { date: '2024-07-03', amount: '-520.00', memo: 'PAGAMENTO DOIS' },
      { date: '2024-07-04', amount: '-630.00', memo: 'PAGAMENTO TRES' },
    ]);
    const ledger = await importLedger(app, admin, [
      { date: '02/07/2024', description: 'DESPESA UM', amount: '-410,00', account: 'CC-AC' },
      { date: '03/07/2024', description: 'DESPESA DOIS', amount: '-520,00', account: 'CC-AC' },
      { date: '04/07/2024', description: 'DESPESA TRES', amount: '-630,00', account: 'CC-AC' },
    ]);
    accountItems = { bank, ledger };
  });

  async function propose(index: number): Promise<string> {
    const proposed = await admin.post('/reconciliation/matches/manual', {
      bankTransactionIds: [accountItems.bank[index].id],
      ledgerEntryIds: [accountItems.ledger[index].id],
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    expect(proposed.body.status).toBe('pending_approval');
    return proposed.body.id as string;
  }

  it('aprovador criado por quem propôs, depois da proposta, é recusado', async () => {
    const matchId = await propose(0);
    const created = await userWithRole(app, admin, 'gestor');
    const approved = await created.post(`/reconciliation/matches/${matchId}/approve`, {});
    expect(approved.status).toBe(403);
    expect(approved.body.error.code).toBe('four_eyes');
  });

  it('aprovador com senha redefinida por quem propôs, depois da proposta, é recusado', async () => {
    const matchId = await propose(1);
    const reset = await admin.post(`/users/${earlierManager.userId}/reset-password`);
    expect(reset.status).toBe(200);
    const client = await loggedIn(app, earlierManager.email, reset.body.temporaryPassword);
    expect(
      (await client.post('/auth/password', { currentPassword: reset.body.temporaryPassword, newPassword: 'Senha-nova-do-gestor-9' })).status,
    ).toBe(204);
    const approved = await client.post(`/reconciliation/matches/${matchId}/approve`, {});
    expect(approved.status).toBe(403);
    expect(approved.body.error.code).toBe('four_eyes');
  });

  it('aprovador independente aprova normalmente', async () => {
    const independent = await userWithRole(app, admin, 'gestor');
    const matchId = await propose(2);
    const approved = await independent.post(`/reconciliation/matches/${matchId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('confirmed');
  });
});
