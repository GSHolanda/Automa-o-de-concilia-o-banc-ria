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

/** Login vindo de um endereço de origem específico (sem proxy à frente). */
function loginFrom(target: FastifyInstance, ip: string, email: string, password: string, headers: Record<string, string> = {}) {
  return target.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, headers, payload: { email, password } });
}

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
    expect(response.body.user.mustChangePassword).toBe(false);
    expect(JSON.stringify(response.body)).not.toMatch(/password_?hash|scrypt\$/i);

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

  it('achado 5: falhas de uma origem atrasam só essa origem; o titular entra de outra', async () => {
    const other = await createTenant();
    const attacker = '203.0.113.10';
    for (let i = 0; i < 6; i += 1) {
      expect((await loginFrom(app, attacker, other.adminEmail, 'senha-errada-000')).statusCode).toBe(401);
    }
    // Da origem das falhas, mesmo a senha certa espera.
    const throttled = await loginFrom(app, attacker, other.adminEmail, other.adminPassword);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error.code).toBe('login_throttled');
    // O titular, de outra origem, entra normalmente.
    expect((await loginFrom(app, '203.0.113.20', other.adminEmail, other.adminPassword)).statusCode).toBe(200);
    // Durante a espera, tentativas não geram registro novo na trilha: 5 falhas + 1 aviso de espera.
    const failures = await ownerPool().query(
      `SELECT count(*)::int AS total FROM audit_log WHERE tenant_id = $1 AND action = 'auth.login_failed'`,
      [other.tenantId],
    );
    expect(failures.rows[0].total).toBe(6);
    // Terminada a espera, a origem volta a entrar.
    await ownerPool().query(`UPDATE login_throttle SET blocked_until = now() - interval '1 second' WHERE user_id = $1`, [
      other.adminUserId,
    ]);
    expect((await loginFrom(app, attacker, other.adminEmail, other.adminPassword)).statusCode).toBe(200);
  });

  it('achado 5: a espera cresce a cada falha depois do limite, até o teto', async () => {
    const other = await createTenant();
    const source = '203.0.113.30';
    const until = async () =>
      (await ownerPool().query('SELECT blocked_until, now() AS now FROM login_throttle WHERE user_id = $1 AND source = $2', [
        other.adminUserId,
        source,
      ])).rows[0];
    for (let i = 0; i < 5; i += 1) await loginFrom(app, source, other.adminEmail, 'senha-errada-000');
    const first = await until();
    const firstWait = first.blocked_until.getTime() - first.now.getTime();
    expect(firstWait).toBeGreaterThan(20_000);
    expect(firstWait).toBeLessThanOrEqual(31_000);
    for (let i = 0; i < 4; i += 1) {
      await ownerPool().query('UPDATE login_throttle SET blocked_until = NULL WHERE user_id = $1', [other.adminUserId]);
      await loginFrom(app, source, other.adminEmail, 'senha-errada-000');
    }
    const later = await until();
    expect(later.blocked_until.getTime() - later.now.getTime()).toBeGreaterThan(400_000);
    for (let i = 0; i < 4; i += 1) {
      await ownerPool().query('UPDATE login_throttle SET blocked_until = NULL WHERE user_id = $1', [other.adminUserId]);
      await loginFrom(app, source, other.adminEmail, 'senha-errada-000');
    }
    const capped = await until();
    expect(capped.blocked_until.getTime() - capped.now.getTime()).toBeLessThanOrEqual(15 * 60_000 + 1_000);
  });

  it('achado 13: senha temporária vence em 72 horas', async () => {
    const admin = await loggedIn(app, tenant.adminEmail);
    const roles = await admin.get('/roles');
    const roleId = roles.body.items.find((role: { key: string }) => role.key === 'analista').id;
    const email = `temporaria-${Date.now()}@exemplo.test`;
    const created = await admin.post('/users', { name: 'Pessoa Temporária', email, roleId });
    expect(created.status).toBe(201);
    const temporary = created.body.temporaryPassword as string;
    await ownerPool().query(`UPDATE users SET password_changed_at = now() - interval '73 hours' WHERE id = $1`, [created.body.id]);
    const expired = await new ApiClient(app).login(email, temporary);
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('temporary_password_expired');
    await ownerPool().query(`UPDATE users SET password_changed_at = now() - interval '71 hours' WHERE id = $1`, [created.body.id]);
    expect((await new ApiClient(app).login(email, temporary)).status).toBe(200);
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

describe('achado 5: limite de login por origem e e-mail, com e sem proxy confiável', () => {
  let limited: FastifyInstance;
  let behindProxy: FastifyInstance;

  beforeAll(async () => {
    limited = await buildTestApp({ RATE_LIMIT_ENABLED: 'true' });
    behindProxy = await buildTestApp({ RATE_LIMIT_ENABLED: 'true', TRUST_PROXY: '1' });
  });
  afterAll(async () => {
    await limited.close();
    await behindProxy.close();
  });

  it('sem proxy confiável, tentativas contra um e-mail não barram o login de outra pessoa pelo mesmo IP', async () => {
    const victim = await createTenant();
    const bystander = await createTenant();
    const sharedIp = '10.9.8.7';
    for (let i = 0; i < 10; i += 1) await loginFrom(limited, sharedIp, victim.adminEmail, 'senha-errada-000');
    expect((await loginFrom(limited, sharedIp, victim.adminEmail, 'senha-errada-000')).statusCode).toBe(429);
    expect((await loginFrom(limited, sharedIp, bystander.adminEmail, bystander.adminPassword)).statusCode).toBe(200);
  });

  it('com TRUST_PROXY=1, variar o X-Forwarded-For não escapa do limite e o IP forjado não vai para a trilha', async () => {
    const victim = await createTenant();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await loginFrom(behindProxy, '10.0.0.5', victim.adminEmail, 'senha-errada-000', {
        'x-forwarded-for': `198.51.100.${i + 1}, 203.0.113.50`,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    const ips = await ownerPool().query(
      `SELECT DISTINCT ip FROM audit_log WHERE tenant_id = $1 AND action = 'auth.login_failed'`,
      [victim.tenantId],
    );
    expect(ips.rows.map((row) => row.ip)).toEqual(['203.0.113.50']);
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

  it('achado 13: senha atual errada conta como falha da origem e passa a esperar', async () => {
    const other = await createTenant();
    const current = await loggedIn(app, other.adminEmail);
    for (let i = 0; i < 5; i += 1) {
      const wrong = await current.post('/auth/password', { currentPassword: `errada-${i}-000`, newPassword: 'Nova-senha-forte-456' });
      expect(wrong.status).toBe(400);
    }
    const blocked = await current.post('/auth/password', { currentPassword: other.adminPassword, newPassword: 'Nova-senha-forte-456' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('login_throttled');
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
