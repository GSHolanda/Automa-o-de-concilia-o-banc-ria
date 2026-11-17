import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate';

/**
 * Cria um banco exclusivo para a execução dos testes, aplica as migrações e o remove ao final.
 * Requer um PostgreSQL acessível com credencial de administrador (TEST_ADMIN_DATABASE_URL).
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const OWNER = process.env.TEST_DB_OWNER_ROLE ?? 'concilia_owner';
const OWNER_PASSWORD = process.env.TEST_DB_OWNER_PASSWORD ?? 'concilia_owner';
const APP = process.env.TEST_DB_APP_ROLE ?? 'concilia_app';
const APP_PASSWORD = process.env.TEST_DB_APP_PASSWORD ?? 'concilia_app';

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(ADMIN_URL);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

export default async function setup(): Promise<() => Promise<void>> {
  const database = `concilia_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    for (const [role, password, extra] of [
      [OWNER, OWNER_PASSWORD, 'CREATEDB'],
      [APP, APP_PASSWORD, 'NOCREATEDB'],
    ] as const) {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0) {
        await admin.query(
          `CREATE ROLE ${pg.escapeIdentifier(role)} LOGIN PASSWORD ${pg.escapeLiteral(password)} NOSUPERUSER NOBYPASSRLS NOCREATEROLE ${extra}`,
        );
      }
    }
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)} OWNER ${pg.escapeIdentifier(OWNER)}`);
    await admin.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(database)} TO ${pg.escapeIdentifier(APP)}`);
  } finally {
    await admin.end();
  }

  const ownerUrl = urlFor(OWNER, OWNER_PASSWORD, database);
  process.env.TEST_OWNER_DATABASE_URL = ownerUrl;
  process.env.TEST_APP_DATABASE_URL = urlFor(APP, APP_PASSWORD, database);
  process.env.TEST_DB_APP_ROLE = APP;
  process.env.TEST_DATABASE_NAME = database;

  await migrate({ connectionString: ownerUrl, appRole: APP });

  return async () => {
    const cleanup = new pg.Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(database)} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };
}
