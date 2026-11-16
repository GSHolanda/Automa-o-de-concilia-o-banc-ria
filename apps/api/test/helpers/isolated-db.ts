import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate';
import { ownerPool } from './db';

export interface IsolatedDatabase {
  /** Conexão com o papel dono do esquema no banco novo. */
  url: string;
  pool: pg.Pool;
  drop: () => Promise<void>;
}

/**
 * Banco exclusivo, já migrado, para operações que cruzam empresas (ex.: troca da chave mestra):
 * dados deixados por outros arquivos de teste no banco compartilhado não interferem.
 */
export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  const name = `concilia_ops_${randomBytes(4).toString('hex')}`;
  await ownerPool().query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
  const url = new URL(process.env.TEST_OWNER_DATABASE_URL as string);
  url.pathname = `/${name}`;
  await migrate({ connectionString: url.toString(), appRole: process.env.TEST_DB_APP_ROLE as string });
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  return {
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.end();
      await ownerPool().query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
    },
  };
}

/** Empresa mínima inserida direto pelo dono do esquema. */
export async function insertTenantRow(pool: pg.Pool, label: string): Promise<{ id: string; slug: string }> {
  const slug = `${label}-${randomBytes(4).toString('hex')}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, trade_name, status) VALUES ($1, $2, $2, 'active') RETURNING id`,
    [slug, `Empresa Fictícia ${slug}`],
  );
  return { id: result.rows[0]!.id, slug };
}
