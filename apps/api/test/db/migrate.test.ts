import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate';
import { closePools, ownerPool } from '../helpers/db';

const options = () => ({
  connectionString: process.env.TEST_OWNER_DATABASE_URL!,
  appRole: process.env.TEST_DB_APP_ROLE!,
});

afterAll(closePools);

describe('executor de migrações', () => {
  it('não reaplica migrações já registradas', async () => {
    const before = await ownerPool().query('SELECT name, applied_at FROM schema_migrations ORDER BY name');
    const result = await migrate(options());
    const after = await ownerPool().query('SELECT name, applied_at FROM schema_migrations ORDER BY name');

    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThanOrEqual(4);
    expect(after.rows).toEqual(before.rows);
  });

  it('interrompe quando uma migração já aplicada foi alterada', async () => {
    const pool = ownerPool();
    const original = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE name = '0001_base.sql'`,
    );
    await pool.query(`UPDATE schema_migrations SET checksum = 'adulterado' WHERE name = '0001_base.sql'`);
    try {
      await expect(migrate(options())).rejects.toThrow(/0001_base\.sql.*alterad/i);
    } finally {
      await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE name = '0001_base.sql'`, [
        original.rows[0]!.checksum,
      ]);
    }
  });

  it('recusa nome de papel da aplicação inválido', async () => {
    await expect(migrate({ ...options(), appRole: 'x; DROP TABLE tenants' })).rejects.toThrow(/papel/i);
  });

  it('o papel da aplicação não é dono, superusuário nem ignora RLS', async () => {
    const client = new pg.Client({ connectionString: process.env.TEST_APP_DATABASE_URL });
    await client.connect();
    try {
      const role = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const owned = await client.query(
        `SELECT count(*)::int AS total FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`,
      );
      expect(owned.rows[0].total).toBe(0);
    } finally {
      await client.end();
    }
  });
});
