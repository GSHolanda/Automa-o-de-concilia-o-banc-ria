import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { assertSafeRuntimeRole, withContext, type Db } from '../../src/db/context';
import {
  appPool,
  asTenant,
  closePools,
  insertRawBankTransaction,
  insertRawTenant,
  ownerPool,
  type RawTenant,
} from '../helpers/db';

let a: RawTenant;
let b: RawTenant;

beforeAll(async () => {
  a = await insertRawTenant('alfa');
  b = await insertRawTenant('beta');
  await insertRawBankTransaction(a);
  await insertRawBankTransaction(b);
  for (const tenant of [a, b]) {
    await ownerPool().query(
      `INSERT INTO chart_accounts (tenant_id, code, name, account_type) VALUES ($1, '1.1', 'Bancos', 'asset')`,
      [tenant.id],
    );
    await ownerPool().query(`INSERT INTO tenant_settings (tenant_id, data) VALUES ($1, '{}')`, [tenant.id]);
  }
});

afterAll(closePools);

describe('isolamento no banco (RLS)', () => {
  it('toda tabela com tenant_id tem RLS habilitado e ao menos uma política', async () => {
    const result = await ownerPool().query<{ table_name: string; rls: boolean; policies: number }>(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM pg_attribute at
                      WHERE at.attrelid = c.oid AND at.attname = 'tenant_id' AND NOT at.attisdropped)
       ORDER BY 1`);
    expect(result.rows.length).toBeGreaterThan(20);
    const unprotected = result.rows.filter((row) => !row.rls || row.policies === 0);
    expect(unprotected).toEqual([]);
  });

  it('nenhuma tabela pública fica sem RLS, exceto o controle de migrações', async () => {
    const result = await ownerPool().query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY 1`);
    expect(result.rows.map((row) => row.relname)).toEqual(['schema_migrations']);
  });

  it('sem contexto, o papel da aplicação não enxerga linha alguma das tabelas de empresa', async () => {
    const tables = await ownerPool().query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM pg_attribute at WHERE at.attrelid = c.oid AND at.attname = 'tenant_id')`);
    await withContext(appPool(), {}, async (db) => {
      for (const { relname } of tables.rows) {
        const rows = await db.query(`SELECT count(*)::int AS total FROM ${relname}`);
        expect({ table: relname, total: rows.rows[0].total }).toEqual({ table: relname, total: 0 });
      }
      const tenants = await db.query('SELECT count(*)::int AS total FROM tenants');
      expect(tenants.rows[0].total).toBe(0);
    });
  });

  it('no contexto da empresa A, só existem linhas da empresa A', async () => {
    await asTenant(a.id, async (db) => {
      for (const table of ['tenants', 'users', 'roles', 'bank_accounts', 'bank_transactions', 'import_batches', 'chart_accounts', 'tenant_settings']) {
        const column = table === 'tenants' ? 'id' : 'tenant_id';
        const rows = await db.query<{ tenant: string }>(`SELECT DISTINCT ${column} AS tenant FROM ${table}`);
        expect({ table, tenants: rows.rows.map((row) => row.tenant) }).toEqual({ table, tenants: [a.id] });
      }
    });
  });

  it('a empresa A não consegue gravar linha em nome da empresa B', async () => {
    await expect(
      asTenant(a.id, (db) =>
        db.query(`INSERT INTO bank_accounts (tenant_id, name) VALUES ($1, 'Conta Invasora')`, [b.id]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a empresa A não altera nem move linhas da empresa B', async () => {
    const updated = await asTenant(a.id, (db) =>
      db.query(`UPDATE bank_accounts SET name = 'Alterada' WHERE tenant_id = $1`, [b.id]),
    );
    expect(updated.rowCount).toBe(0);

    await expect(
      asTenant(a.id, (db) => db.query(`UPDATE bank_accounts SET tenant_id = $1`, [b.id])),
    ).rejects.toThrow(/row-level security/i);

    const intact = await ownerPool().query(`SELECT name FROM bank_accounts WHERE tenant_id = $1`, [b.id]);
    expect(intact.rows).toEqual([{ name: 'Conta Movimento' }]);
  });

  it('chave estrangeira composta impede referência a registro de outra empresa', async () => {
    const foreign = await ownerPool().query<{ id: string }>(
      `SELECT id FROM chart_accounts WHERE tenant_id = $1`,
      [b.id],
    );
    await expect(
      asTenant(a.id, (db) =>
        db.query(
          `INSERT INTO categories (tenant_id, code, name, kind, account_id) VALUES ($1, 'TAR', 'Tarifas', 'fee', $2)`,
          [a.id, foreign.rows[0]!.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('o contexto vale só para a transação: a conexão devolvida ao pool não o carrega', async () => {
    const single = appPool();
    await asTenant(a.id, (db) => db.query('SELECT 1'));
    for (let i = 0; i < 10; i += 1) {
      const result = await single.query('SELECT app_tenant_id() AS tenant, (SELECT count(*)::int FROM bank_accounts) AS total');
      expect(result.rows[0]).toEqual({ tenant: null, total: 0 });
    }
  });

  it('o contexto de plataforma enxerga empresas, mas não dados financeiros', async () => {
    await withContext(appPool(), { platform: true }, async (db) => {
      const tenants = await db.query('SELECT count(*)::int AS total FROM tenants WHERE id = ANY($1)', [[a.id, b.id]]);
      expect(tenants.rows[0].total).toBe(2);
      for (const table of ['bank_transactions', 'bank_accounts', 'import_batches', 'tenant_settings']) {
        const rows = await db.query(`SELECT count(*)::int AS total FROM ${table}`);
        expect({ table, total: rows.rows[0].total }).toEqual({ table, total: 0 });
      }
    });
  });

  it('fora do contexto de plataforma, a empresa não muda o próprio slug nem a própria situação', async () => {
    await expect(
      asTenant(a.id, (db) => db.query(`UPDATE tenants SET slug = 'outro-slug' WHERE id = $1`, [a.id])),
    ).rejects.toThrow(/plataforma/);
    await expect(
      asTenant(a.id, (db) => db.query(`UPDATE tenants SET status = 'archived' WHERE id = $1`, [a.id])),
    ).rejects.toThrow(/plataforma/);
  });
});

describe('revisão de segurança, achado 8: linha de users', () => {
  const asSelf = <T>(fn: (db: Db) => Promise<T>) => asTenant(a.id, fn, { userId: a.userId });

  it('o próprio usuário não se promove a operador da plataforma nem sai da empresa', async () => {
    await expect(
      asSelf((db) =>
        db.query('UPDATE users SET tenant_id = NULL, role_id = NULL, is_platform_admin = true WHERE id = $1', [a.userId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asSelf((db) => db.query('UPDATE users SET tenant_id = $2 WHERE id = $1', [a.userId, b.id]))).rejects.toMatchObject({
      code: expect.stringMatching(/42501|23503/),
    });
  });

  it('o próprio usuário não muda o próprio papel nem a própria situação; o nome pode', async () => {
    const otherRole = await ownerPool().query<{ id: string }>(
      `INSERT INTO roles (tenant_id, key, name, permissions) VALUES ($1, 'outro-papel', 'Outro', '{}') RETURNING id`,
      [a.id],
    );
    await expect(
      asSelf((db) => db.query('UPDATE users SET role_id = $2 WHERE id = $1', [a.userId, otherRole.rows[0]!.id])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asSelf((db) => db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [a.userId]))).rejects.toMatchObject({
      code: '42501',
    });
    const renamed = await asSelf((db) => db.query(`UPDATE users SET name = 'Nome novo' WHERE id = $1`, [a.userId]));
    expect(renamed.rowCount).toBe(1);
  });

  it('outro usuário da empresa não move linha para outra empresa nem cria operador da plataforma', async () => {
    const colleague = await ownerPool().query<{ id: string }>(
      `INSERT INTO users (tenant_id, role_id, email, name, password_hash) VALUES ($1, $2, $3, 'Colega', 'x') RETURNING id`,
      [a.id, a.roleId, `colega-${randomUUID().slice(0, 8)}@exemplo.test`],
    );
    const asColleague = <T>(fn: (db: Db) => Promise<T>) => asTenant(a.id, fn, { userId: colleague.rows[0]!.id });
    await expect(
      asColleague((db) => db.query('UPDATE users SET tenant_id = NULL, role_id = NULL, is_platform_admin = true WHERE id = $1', [a.userId])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asColleague((db) =>
        db.query(
          `INSERT INTO users (tenant_id, role_id, email, name, password_hash, is_platform_admin) VALUES (NULL, NULL, 'x@exemplo.test', 'X', 'x', true)`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('no contexto de plataforma, usuários de empresa (e seus hashes) não são visíveis; a contagem vem de função', async () => {
    await withContext(appPool(), { platform: true }, async (db) => {
      const visible = await db.query('SELECT count(*)::int AS total FROM users WHERE tenant_id IS NOT NULL');
      expect(visible.rows[0].total).toBe(0);
      const counted = await db.query('SELECT platform_tenant_active_users($1) AS total', [a.id]);
      expect(counted.rows[0].total).toBeGreaterThan(0);
    });
    const outside = await asTenant(b.id, (db) => db.query('SELECT platform_tenant_active_users($1) AS total', [a.id]));
    expect(outside.rows[0].total).toBeNull();
  });
});

describe('verificação do papel de execução', () => {
  it('aceita o papel da aplicação', async () => {
    await expect(assertSafeRuntimeRole(appPool())).resolves.toBeUndefined();
  });

  it('recusa o papel dono do esquema', async () => {
    await expect(assertSafeRuntimeRole(ownerPool())).rejects.toThrow(/dono|RLS/i);
  });
});
