import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Sobe um ambiente isolado: banco próprio, migrações, dados de demonstração, interface compilada e API.
 * Os dados são todos fictícios.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const OWNER = { user: 'concilia_owner', password: 'concilia_owner' };
const APP = { user: 'concilia_app', password: 'concilia_app' };

export const DEMO_PASSWORD = 'Demo-Senha-e2e-2024';
export const PLATFORM_EMAIL = 'operador@plataforma.exemplo.test';
export const PLATFORM_PASSWORD = 'Senha-Plataforma-e2e-2024';

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(ADMIN_URL);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => ok(port));
    });
  });
}

function run(args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync('pnpm', args, { cwd: root, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} falhou:\n${result.stdout}\n${result.stderr}`);
  }
}

let api: ChildProcess | null = null;
let database = '';

async function dropDatabase(): Promise<void> {
  if (!database) return;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(database)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  database = `concilia_e2e_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    for (const [role, extra] of [[OWNER, 'CREATEDB'], [APP, 'NOCREATEDB']] as const) {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role.user]);
      if (exists.rowCount === 0) {
        await admin.query(
          `CREATE ROLE ${pg.escapeIdentifier(role.user)} LOGIN PASSWORD ${pg.escapeLiteral(role.password)} NOSUPERUSER NOBYPASSRLS NOCREATEROLE ${extra}`,
        );
      }
    }
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)} OWNER ${pg.escapeIdentifier(OWNER.user)}`);
    await admin.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(database)} TO ${pg.escapeIdentifier(APP.user)}`);
  } finally {
    await admin.end();
  }

  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'warn',
    DATABASE_URL: urlFor(APP.user, APP.password, database),
    MIGRATION_DATABASE_URL: urlFor(OWNER.user, OWNER.password, database),
    DB_APP_ROLE: APP.user,
    SESSION_SECRET: 'segredo-de-sessao-apenas-para-e2e-0123456789abcdef',
    SECRETS_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
    COOKIE_SECURE: 'false',
    RATE_LIMIT_ENABLED: 'false',
    PASSWORD_SCRYPT_COST: '12',
    WORKER_ENABLED: 'true',
    WORKER_POLL_MS: '200',
    WEB_DIST_DIR: resolve(root, 'apps/web/dist'),
  };

  try {
    run(['--filter', '@concilia/api', 'cli', 'db:migrate'], env);
    run(['--filter', '@concilia/api', 'cli', 'platform:create-admin', '--email', PLATFORM_EMAIL, '--name', 'Operador da Plataforma'], {
      ...env,
      CONCILIA_ADMIN_PASSWORD: PLATFORM_PASSWORD,
    });
    run(['--filter', '@concilia/api', 'cli', 'demo:seed'], { ...env, DEMO_PASSWORD });
    run(['--filter', '@concilia/web', 'build'], env);

    api = spawn(resolve(root, 'apps/api/node_modules/.bin/tsx'), ['apps/api/src/main.ts'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    api.stdout?.on('data', (chunk) => (log += String(chunk)));
    api.stderr?.on('data', (chunk) => (log += String(chunk)));
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (api.exitCode !== null) throw new Error(`A API encerrou ao iniciar:\n${log}`);
      try {
        const res = await fetch(`${base}/readyz`);
        if (res.ok) break;
      } catch {
        /* ainda subindo */
      }
      if (Date.now() > deadline) throw new Error(`A API não ficou pronta em 60 s:\n${log}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    process.env.E2E_BASE_URL = base;
  } catch (error) {
    api?.kill('SIGKILL');
    await dropDatabase();
    throw error;
  }

  return async () => {
    if (api && api.exitCode === null) {
      const done = new Promise((r) => api?.once('exit', r));
      api.kill('SIGTERM');
      await Promise.race([done, new Promise((r) => setTimeout(r, 10_000))]);
      if (api.exitCode === null) api.kill('SIGKILL');
    }
    await dropDatabase();
  };
}
