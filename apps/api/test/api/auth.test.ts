import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, buildTestApp, createPlatformUser, createTenant, loggedIn, userWithRole, TEST_PASSWORD, type TestTenant } from '../helpers/app';
import { closePools, ownerPool } from '../helpers/db';

let app: FastifyInstance;
let tenant: TestTenant;

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant();
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('login', () => {
  it('autentica, devolve o contexto do usuário e grava cookie HttpOnly', async () => {
    const client = new ApiClient(app);
    const response = await client.login(tenant.adminEmail, tenant.adminPassword);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ email: tenant.adminEmail, name: 'Administradora Teste' });
    expect(response.body.tenant).toMatchObject({ id: tenant.tenantId, slug: tenant.slug });
    expect(response.body.role.key).toBe('admin');
    expect(response.body.permissions).toContain('users.manage');
    expect(response.body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(response.body)).not.toMatch(/password|hash/i);

    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(/concilia_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await client.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(tenant.adminEmail);
  });

  it('devolve a mesma resposta para senha errada e para e-mail inexistente', async () => {
    const wrong = await new ApiClient(app).login(tenant.adminEmail, 'senha-errada-000');
    const unknown = await new ApiClient(app).login('ninguem@exemplo.test', 'senha-errada-000');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ error: { ...wrong.body.error, requestId: unknown.body.error.requestId } });
    expect(wrong.body.error.code).toBe('invalid_credentials');
  });

  it('bloqueia a conta após falhas sucessivas, mesmo com a senha correta', async () => {
    const other = await createTenant();
    for (let i = 0; i < 5; i += 1) await new ApiClient(app).login(other.adminEmail, 'senha-errada-000');
    const locked = await new ApiClient(app).login(other.adminEmail, other.adminPassword);
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('account_locked');

    await ownerPool().query(`UPDATE users SET locked_until = now() - interval '1 minute' WHERE lower(email) = $1`, [other.adminEmail]);
    expect((await new ApiClient(app).login(other.adminEmail, other.adminPassword)).status).toBe(200);
  });

  it('recusa usuário desativado e derruba as sessões que ele tinha', async () => {
    const admin = await loggedIn(app, tenant.adminEmail);
    const analyst = await userWithRole(app, admin, 'analista');
    expect((await analyst.get('/auth/me')).status).toBe(200);

    const disabled = await admin.patch(`/users/${analyst.userId}`, { status: 'disabled' });
    expect(disabled.status).toBe(200);
    expect((await analyst.get('/auth/me')).status).toBe(401);
    const login = await new ApiClient(app).login(analyst.email, TEST_PASSWORD);
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('account_disabled');
  });
});

describe('sessão', () => {
  it('rota protegida sem autenticação responde 401', async () => {
    const response = await new ApiClient(app).get('/users');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthenticated');
  });

  it('requisição de escrita sem o cabeçalho CSRF responde 403', async () => {
    const admin = await loggedIn(app, tenant.adminEmail);
    const response = await admin.post('/roles', { key: 'x-teste', name: 'X', permissions: [] }, { 'x-csrf-token': 'errado' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('csrf_invalid');
  });

  it('logout revoga a sessão imediatamente', async () => {
    const client = await loggedIn(app, tenant.adminEmail);
    expect((await client.post('/auth/logout')).status).toBe(204);
    expect((await client.get('/auth/me')).status).toBe(401);
  });

  it('lista as sessões do usuário e permite encerrar outra sessão', async () => {
    const first = await loggedIn(app, tenant.adminEmail);
    const second = await loggedIn(app, tenant.adminEmail);
    const list = await first.get('/auth/sessions');
    expect(list.status).toBe(200);
    const current = list.body.items.find((entry: { current: boolean }) => entry.current);
    const others = list.body.items.filter((entry: { current: boolean }) => !entry.current);
    expect(current).toBeDefined();
    expect(others.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(list.body)).not.toMatch(/token/i);

    for (const session of others) expect((await first.delete(`/auth/sessions/${session.id}`)).status).toBe(204);
    expect((await second.get('/auth/me')).status).toBe(401);
    expect((await first.get('/auth/me')).status).toBe(200);
  });

  it('expira por inatividade', async () => {
    const client = await loggedIn(app, tenant.adminEmail);
    await ownerPool().query(
      `UPDATE sessions SET last_seen_at = now() - interval '3 hours' WHERE id = (SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
      [tenant.adminUserId],
    );
    const response = await client.get('/auth/me');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('session_expired');
  });

  it('expira no prazo absoluto', async () => {
    const client = await loggedIn(app, tenant.adminEmail);
    await ownerPool().query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = (SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
      [tenant.adminUserId],
    );
    expect((await client.get('/auth/me')).status).toBe(401);
  });

  it('cookie com token desconhecido responde 401', async () => {
    const client = new ApiClient(app, { cookie: 'concilia_sid=token-que-nao-existe', csrf: 'x', body: null });
    expect((await client.get('/auth/me')).status).toBe(401);
  });
});

describe('senha', () => {
  it('troca a senha, encerra as outras sessões e passa a aceitar só a nova', async () => {
    const other = await createTenant();
    const current = await loggedIn(app, other.adminEmail);
    const elsewhere = await loggedIn(app, other.adminEmail);

    const wrong = await current.post('/auth/password', { currentPassword: 'nao-e-esta-000', newPassword: 'Nova-senha-forte-456' });
    expect(wrong.status).toBe(400);
    const short = await current.post('/auth/password', { currentPassword: other.adminPassword, newPassword: 'curta' });
    expect(short.status).toBe(400);

    const changed = await current.post('/auth/password', { currentPassword: other.adminPassword, newPassword: 'Nova-senha-forte-456' });
    expect(changed.status).toBe(204);
    expect((await current.get('/auth/me')).status).toBe(200);
    expect((await elsewhere.get('/auth/me')).status).toBe(401);
    expect((await new ApiClient(app).login(other.adminEmail, other.adminPassword)).status).toBe(401);
    expect((await new ApiClient(app).login(other.adminEmail, 'Nova-senha-forte-456')).status).toBe(200);
  });

  it('guarda a senha apenas como hash scrypt com sal', async () => {
    const row = await ownerPool().query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [tenant.adminUserId]);
    expect(row.rows[0]!.password_hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(row.rows[0]!.password_hash).not.toContain(TEST_PASSWORD);
  });
});

describe('permissões', () => {
  it('usuário sem a permissão exigida recebe 403', async () => {
    const admin = await loggedIn(app, tenant.adminEmail);
    const auditor = await userWithRole(app, admin, 'auditor');
    const response = await auditor.post('/users', { name: 'X', email: 'x@exemplo.test', roleId: '00000000-0000-0000-0000-000000000000' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
    expect((await auditor.get('/users')).status).toBe(403);
    expect((await auditor.get('/audit')).status).toBe(200);
  });

  it('usuário de empresa não acessa rotas da plataforma', async () => {
    const admin = await loggedIn(app, tenant.adminEmail);
    expect((await admin.get('/platform/tenants')).status).toBe(403);
  });

  it('operador da plataforma administra empresas mas não acessa dados de empresa', async () => {
    const platform = await createPlatformUser();
    const operator = await loggedIn(app, platform.email, platform.password);
    expect(operator.session?.body.tenant).toBeNull();
    const tenants = await operator.get('/platform/tenants');
    expect(tenants.status).toBe(200);
    expect(tenants.body.items.some((entry: { id: string }) => entry.id === tenant.tenantId)).toBe(true);
    expect((await operator.get('/users')).status).toBe(403);
    expect((await operator.get('/audit')).status).toBe(403);
  });
});

describe('auditoria de autenticação', () => {
  it('registra login, falha de login, troca de senha e logout, sem expor senha ou hash', async () => {
    const other = await createTenant();
    await new ApiClient(app).login(other.adminEmail, 'senha-errada-000');
    const client = await loggedIn(app, other.adminEmail);
    await client.post('/auth/password', { currentPassword: other.adminPassword, newPassword: 'Outra-senha-forte-789' });
    const audit = await client.get('/audit?limit=50');
    await client.post('/auth/logout');

    expect(audit.status).toBe(200);
    const actions = audit.body.items.map((entry: { action: string }) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login_failed', 'auth.login', 'auth.password_changed']));
    const text = JSON.stringify(audit.body);
    expect(text).not.toContain('Outra-senha-forte-789');
    expect(text).not.toContain('scrypt$');

    const logout = await ownerPool().query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'auth.logout'`, [other.tenantId]);
    expect(logout.rowCount).toBe(1);
  });

  it('verifica a integridade da cadeia pela API', async () => {
    const admin = await loggedIn(app, tenant.adminEmail);
    const response = await admin.get('/audit/verify');
    expect(response.status).toBe(200);
    expect(response.body.intact).toBe(true);
    expect(response.body.checked).toBeGreaterThan(0);
    expect(response.body.headHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('infraestrutura', () => {
  it('responde às verificações de vida e de prontidão', async () => {
    const client = new ApiClient(app);
    expect((await client.get('/healthz')).body).toEqual({ status: 'ok' });
    const ready = await client.get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ok', database: 'ok', schema: 'ok' });
  });

  it('publica a especificação OpenAPI gerada das rotas', async () => {
    const response = await new ApiClient(app).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.openapi).toMatch(/^3\./);
    expect(response.body.paths['/api/v1/auth/login'].post).toBeDefined();
    expect(response.body.paths['/api/v1/users'].get['x-permission']).toBe('users.manage');
  });

  it('devolve erro de validação estruturado', async () => {
    const response = await new ApiClient(app).post('/auth/login', { email: 'nao-e-email' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details.length).toBeGreaterThan(0);
  });

  it('rota inexistente responde 404 em JSON', async () => {
    const response = await new ApiClient(app).get('/nao-existe');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});
