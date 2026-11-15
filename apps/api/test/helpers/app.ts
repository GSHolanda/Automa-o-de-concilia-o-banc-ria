import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { loadConfig, type Config } from '../../src/config/env';
import { withContext } from '../../src/db/context';
import { createPlatformAdmin, provisionTenant, type ProvisionedTenant } from '../../src/modules/tenancy/provisioning';
import { appPool } from './db';

export const TEST_PASSWORD = 'Senha-de-teste-123';

export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL,
    MIGRATION_DATABASE_URL: process.env.TEST_OWNER_DATABASE_URL,
    DB_APP_ROLE: process.env.TEST_DB_APP_ROLE,
    SESSION_SECRET: 'segredo-de-sessao-apenas-para-testes-0123456789',
    SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    PASSWORD_SCRYPT_COST: '12',
    COOKIE_SECURE: 'false',
    RATE_LIMIT_ENABLED: 'false',
    WORKER_ENABLED: 'false',
    ALLOW_PRIVATE_INTEGRATION_HOSTS: 'true',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export async function buildTestApp(overrides: Partial<Record<string, string>> = {}): Promise<FastifyInstance> {
  const app = await buildApp(testConfig(overrides));
  await app.ready();
  return app;
}

export interface TestTenant extends ProvisionedTenant {
  adminEmail: string;
  adminPassword: string;
}

export async function createTenant(
  options: { plan?: string; label?: string; status?: 'onboarding' | 'active' } = {},
): Promise<TestTenant> {
  const suffix = randomBytes(4).toString('hex');
  const adminEmail = `admin-${suffix}@exemplo.test`;
  const config = testConfig();
  const provisioned = await withContext(appPool(), { platform: true }, (db) =>
    provisionTenant(db, config, {
      slug: `${options.label ?? 'empresa'}-${suffix}`,
      legalName: `Empresa Fictícia ${suffix} Ltda`,
      tradeName: `Empresa ${suffix}`,
      taxId: null,
      planCode: options.plan ?? 'corporativo',
      status: options.status ?? 'active',
      admin: { name: 'Administradora Teste', email: adminEmail, password: TEST_PASSWORD },
      actor: { type: 'system', id: null, label: 'testes' },
    }),
  );
  return { ...provisioned, adminEmail, adminPassword: TEST_PASSWORD };
}

export async function createPlatformUser(): Promise<{ email: string; password: string }> {
  const email = `plataforma-${randomBytes(4).toString('hex')}@exemplo.test`;
  await withContext(appPool(), { platform: true }, (db) =>
    createPlatformAdmin(db, testConfig(), { name: 'Operadora da Plataforma', email, password: TEST_PASSWORD }),
  );
  return { email, password: TEST_PASSWORD };
}

export interface Session {
  cookie: string;
  csrf: string;
  body: any;
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Record<string, unknown>;
  raw: Buffer;
}

export class ApiClient {
  constructor(
    private readonly app: FastifyInstance,
    public session: Session | null = null,
  ) {}

  private async send(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
    const base: Record<string, string> = { ...headers };
    if (this.session) {
      base.cookie = this.session.cookie;
      if (method !== 'GET' && base['x-csrf-token'] === undefined) base['x-csrf-token'] = this.session.csrf;
    }
    const response = await this.app.inject({
      method: method as 'GET',
      url: url.startsWith('/api') || url.startsWith('/healthz') || url.startsWith('/readyz') || url.startsWith('/metrics') ? url : `/api/v1${url}`,
      headers: base,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    let body: unknown = null;
    const type = String(response.headers['content-type'] ?? '');
    if (type.includes('application/json')) body = response.json();
    else body = response.body;
    return { status: response.statusCode, body, headers: response.headers, raw: response.rawPayload };
  }

  get(url: string, headers?: Record<string, string>) {
    return this.send('GET', url, undefined, headers);
  }
  post(url: string, payload?: unknown, headers?: Record<string, string>) {
    return this.send('POST', url, payload ?? {}, headers);
  }
  put(url: string, payload?: unknown, headers?: Record<string, string>) {
    return this.send('PUT', url, payload ?? {}, headers);
  }
  patch(url: string, payload?: unknown, headers?: Record<string, string>) {
    return this.send('PATCH', url, payload ?? {}, headers);
  }
  delete(url: string, headers?: Record<string, string>) {
    return this.send('DELETE', url, undefined, headers);
  }

  async login(email: string, password: string): Promise<ApiResponse> {
    const response = await this.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    const body = response.json();
    if (response.statusCode === 200) {
      const setCookie = response.headers['set-cookie'];
      const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      this.session = { cookie: String(first).split(';')[0]!, csrf: body.csrfToken, body };
    }
    return { status: response.statusCode, body, headers: response.headers, raw: response.rawPayload };
  }
}

export async function loggedIn(app: FastifyInstance, email: string, password = TEST_PASSWORD): Promise<ApiClient> {
  const client = new ApiClient(app);
  const response = await client.login(email, password);
  if (response.status !== 200) throw new Error(`Login de teste falhou: ${response.status} ${JSON.stringify(response.body)}`);
  return client;
}

/** Cria um usuário com o papel indicado e devolve um cliente já autenticado. */
export async function userWithRole(app: FastifyInstance, admin: ApiClient, roleKey: string): Promise<ApiClient & { email: string; userId: string }> {
  const roles = await admin.get('/roles');
  const role = roles.body.items.find((entry: { key: string }) => entry.key === roleKey);
  if (!role) throw new Error(`Papel ${roleKey} não encontrado`);
  const email = `${roleKey}-${randomBytes(4).toString('hex')}@exemplo.test`;
  const created = await admin.post('/users', { name: `Pessoa ${roleKey}`, email, roleId: role.id, password: TEST_PASSWORD });
  if (created.status !== 201) throw new Error(`Criação de usuário falhou: ${JSON.stringify(created.body)}`);
  const client = await loggedIn(app, email);
  return Object.assign(client, { email, userId: created.body.id as string });
}
