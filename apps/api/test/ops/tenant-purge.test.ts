import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../../src/db/context';
import { purgeTenant } from '../../src/ops/tenant-purge';
import { TenantOpsError } from '../../src/ops/tenant-data';
import { buildTestApp } from '../helpers/app';
import { closePools, ownerPool } from '../helpers/db';
import { populatedTenant, type PopulatedTenant } from '../helpers/populated-tenant';

const OWNER_URL = () => process.env.TEST_OWNER_DATABASE_URL as string;

let app: FastifyInstance;
let doomed: PopulatedTenant;
let kept: PopulatedTenant;

/** Toda tabela do esquema com coluna tenant_id, descoberta pelo catálogo (tabelas futuras entram sozinhas). */
async function tablesWithTenantId(): Promise<string[]> {
  const result = await ownerPool().query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

async function countsFor(tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of await tablesWithTenantId()) {
    const result = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = $1`, [
      tenantId,
    ]);
    counts[table] = result.rows[0]!.n;
  }
  const tenant = await ownerPool().query<{ n: number }>('SELECT count(*)::int AS n FROM tenants WHERE id = $1', [tenantId]);
  counts.tenants = tenant.rows[0]!.n;
  return counts;
}

async function chain(tenantId: string | null) {
  const result = await ownerPool().query('SELECT * FROM audit_verify_chain($1)', [tenantId]);
  return result.rows[0];
}

const setStatus = (tenantId: string, status: string) =>
  withContext(ownerPool(), { platform: true }, (db) => db.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenantId, status]));

beforeAll(async () => {
  app = await buildTestApp();
  doomed = await populatedTenant(app, 'elimina');
  kept = await populatedTenant(app, 'permanece');
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('tenant:purge', () => {
  it('exige o slug repetido em --confirm', async () => {
    await setStatus(doomed.tenantId, 'archived');
    await expect(purgeTenant({ connectionString: OWNER_URL(), slug: doomed.slug, confirm: 'outra' })).rejects.toThrow(
      /--confirm/,
    );
    expect((await countsFor(doomed.tenantId)).tenants).toBe(1);
  });

  it('recusa empresa que não esteja arquivada e empresa inexistente', async () => {
    await setStatus(doomed.tenantId, 'suspended');
    await expect(purgeTenant({ connectionString: OWNER_URL(), slug: doomed.slug, confirm: doomed.slug })).rejects.toThrow(
      /arquivada/,
    );
    await expect(
      purgeTenant({ connectionString: OWNER_URL(), slug: 'nao-existe-y', confirm: 'nao-existe-y' }),
    ).rejects.toBeInstanceOf(TenantOpsError);
    const counts = await countsFor(doomed.tenantId);
    expect(counts.tenants).toBe(1);
    expect(counts.bank_transactions).toBeGreaterThan(0);
  });

  it('elimina tudo da empresa arquivada, preserva a outra e registra a eliminação na plataforma', async () => {
    await setStatus(doomed.tenantId, 'archived');
    const before = await countsFor(doomed.tenantId);
    // A empresa tem dados em tabelas protegidas por gatilho e nas demais.
    for (const table of ['bank_transactions', 'ledger_entries', 'audit_log', 'matches', 'match_items', 'sessions',
      'integrations', 'api_tokens', 'import_files', 'users', 'jobs']) {
      expect(before[table], table).toBeGreaterThan(0);
    }
    const keptBefore = await countsFor(kept.tenantId);
    const keptChainBefore = await chain(kept.tenantId);
    const platformBefore = await chain(null);
    expect(keptChainBefore.broken_seq).toBeNull();

    const result = await purgeTenant({ connectionString: OWNER_URL(), slug: doomed.slug, confirm: doomed.slug });
    expect(result.tenantId).toBe(doomed.tenantId);
    expect(result.rows).toBe(Object.values(before).reduce((sum, n) => sum + n, 0));

    const after = await countsFor(doomed.tenantId);
    for (const [table, n] of Object.entries(after)) expect(n, table).toBe(0);

    expect(await countsFor(kept.tenantId)).toEqual(keptBefore);
    const keptChain = await chain(kept.tenantId);
    expect(keptChain.broken_seq).toBeNull();
    expect(keptChain.checked).toBe(keptChainBefore.checked);
    expect(keptChain.head_hash).toBe(keptChainBefore.head_hash);

    const platform = await chain(null);
    expect(platform.broken_seq).toBeNull();
    expect(Number(platform.checked)).toBe(Number(platformBefore.checked) + 1);
    const record = await ownerPool().query(
      `SELECT * FROM audit_log WHERE tenant_id IS NULL AND action = 'platform.tenant_purged' AND entity_id = $1`,
      [doomed.tenantId],
    );
    expect(record.rows).toHaveLength(1);
    const text = JSON.stringify(record.rows[0]);
    for (const value of [doomed.slug, doomed.adminEmail, 'Empresa Fictícia']) expect(text).not.toContain(value);

    // A empresa mantida continua funcionando normalmente.
    expect((await kept.admin.get('/imports')).status).toBe(200);
  });

  it('os gatilhos de proteção voltam a valer depois da eliminação', async () => {
    await expect(ownerPool().query('DELETE FROM bank_transactions WHERE tenant_id = $1', [kept.tenantId])).rejects.toThrow(
      /não podem ser apagados/,
    );
    await expect(ownerPool().query('DELETE FROM audit_log WHERE tenant_id = $1', [kept.tenantId])).rejects.toThrow(
      /não pode ser alterada/,
    );
    const disabled = await ownerPool().query(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'D'`,
    );
    expect(disabled.rows).toEqual([]);
  });

  it('o login de quem era da empresa eliminada deixa de funcionar', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: doomed.adminEmail, password: doomed.adminPassword },
    });
    expect(response.statusCode).toBe(401);
  });
});
