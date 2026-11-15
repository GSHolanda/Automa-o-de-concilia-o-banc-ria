import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export interface MigrateOptions {
  /** Conexão com o papel dono do esquema. Nunca use o papel da aplicação aqui. */
  connectionString: string;
  /** Papel de banco usado pela aplicação em execução; recebe apenas os privilégios necessários. */
  appRole: string;
  dir?: string;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const LOCK_KEY = 7_265_001;

export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db (desenvolvimento) ou dist (produção): as migrações ficam em apps/api/migrations.
  return process.env.MIGRATIONS_DIR ?? join(here, here.endsWith('dist') ? '..' : '../..', 'migrations');
}

/**
 * Aplica, em ordem, as migrações ainda não registradas. Somente para frente.
 * Cada arquivo roda em uma transação; um arquivo já aplicado que tenha sido alterado interrompe a execução.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  if (!ROLE_NAME.test(options.appRole)) {
    throw new Error(`Nome de papel da aplicação inválido: "${options.appRole}"`);
  }
  const dir = options.dir ?? defaultMigrationsDir();
  const log = options.log ?? (() => undefined);
  const files = (await readdir(dir)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (files.length === 0) throw new Error(`Nenhuma migração encontrada em ${dir}`);

  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    // Uma execução por vez, mesmo com várias instâncias subindo juntas.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [options.appRole]);
    if (role.rowCount === 0) {
      throw new Error(
        `O papel da aplicação "${options.appRole}" não existe. Execute ops/db-bootstrap.sh antes das migrações.`,
      );
    }

    const done = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(done.rows.map((row) => [row.name, row.checksum]));

    for (const file of files) {
      const source = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `A migração ${file} já foi aplicada e depois alterada (checksum diferente). ` +
              'Migrações aplicadas não podem ser editadas: crie uma nova migração corretiva.',
          );
        }
        result.skipped.push(file);
        continue;
      }
      const sql = source.replaceAll('{{app_role}}', pg.escapeIdentifier(options.appRole));
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Falha ao aplicar ${file}: ${(error as Error).message}`, { cause: error });
      }
      log(`migração aplicada: ${file}`);
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

/** Nome da última migração registrada, ou nulo se nenhuma foi aplicada. */
export async function currentSchemaVersion(pool: pg.Pool): Promise<string | null> {
  const result = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
  );
  return result.rows[0]?.name ?? null;
}

export async function expectedSchemaVersion(dir = defaultMigrationsDir()): Promise<string | null> {
  const files = (await readdir(dir)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  return files.at(-1) ?? null;
}
