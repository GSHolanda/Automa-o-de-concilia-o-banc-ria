import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportTenant, TenantOpsError } from '../../src/ops/tenant-export';
import { buildTestApp } from '../helpers/app';
import { closePools, ownerPool } from '../helpers/db';
import { populatedTenant, type PopulatedTenant } from '../helpers/populated-tenant';

const OWNER_URL = () => process.env.TEST_OWNER_DATABASE_URL as string;

let app: FastifyInstance;
let tenant: PopulatedTenant;
let other: PopulatedTenant;
let dir: string;

interface Line {
  type: 'header' | 'row' | 'summary';
  table?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

async function readLines(file: string): Promise<{ raw: string; lines: Line[] }> {
  const raw = await readFile(file, 'utf8');
  return { raw, lines: raw.trimEnd().split('\n').map((line) => JSON.parse(line) as Line) };
}

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await populatedTenant(app, 'exporta');
  other = await populatedTenant(app, 'naoexporta');
  dir = await mkdtemp(join(tmpdir(), 'concilia-export-'));
});

afterAll(async () => {
  await app.close();
  await closePools();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('tenant:export', () => {
  it('empresa inexistente: erro claro, nenhum arquivo', async () => {
    const out = join(dir, 'nada.ndjson');
    await expect(exportTenant({ connectionString: OWNER_URL(), slug: 'nao-existe-x', out })).rejects.toBeInstanceOf(
      TenantOpsError,
    );
    await expect(readFile(out)).rejects.toThrow();
  });

  it('exporta em NDJSON todos os dados da empresa, sem segredos, hashes de senha nem tokens', async () => {
    const out = join(dir, `${tenant.slug}.ndjson`);
    const result = await exportTenant({ connectionString: OWNER_URL(), slug: tenant.slug, out });
    const { raw, lines } = await readLines(out);

    expect(lines[0]).toMatchObject({ type: 'header', format: 'concilia.tenant-export', tenant: { id: tenant.tenantId, slug: tenant.slug } });
    expect(lines.at(-1)).toMatchObject({ type: 'summary' });
    const rows = lines.filter((line) => line.type === 'row');
    expect(rows.length).toBe(result.rows);
    const tables = new Set(rows.map((line) => line.table));
    for (const table of [
      'tenants', 'tenant_settings', 'tenant_licenses', 'tenant_modules', 'roles', 'users', 'bank_accounts', 'categories',
      'classification_rules', 'report_templates', 'integrations', 'api_tokens', 'import_batches',
      'bank_transactions', 'ledger_entries', 'reconciliation_runs', 'matches', 'match_items', 'audit_log',
    ]) {
      expect(tables, table).toContain(table);
    }
    // Sessões são credenciais de acesso; arquivos originais só com includeFiles.
    expect(tables).not.toContain('sessions');
    expect(tables).not.toContain('import_files');

    // Toda linha é da empresa exportada.
    for (const line of rows) {
      const owner = line.table === 'tenants' ? line.data!.id : line.data!.tenant_id;
      expect(owner, line.table).toBe(tenant.tenantId);
    }
    expect(raw).not.toContain(other.tenantId);

    // Sem segredos, hashes de senha nem tokens.
    const users = rows.filter((line) => line.table === 'users');
    expect(users.length).toBe(2);
    for (const user of users) expect(user.data).not.toHaveProperty('password_hash');
    const integration = rows.find((line) => line.table === 'integrations')!;
    expect(integration.data).not.toHaveProperty('secret_ciphertext');
    expect(integration.data).toHaveProperty('name', 'Gancho fictício');
    const token = rows.find((line) => line.table === 'api_tokens')!;
    expect(token.data).not.toHaveProperty('token_hash');
    expect(raw).not.toContain(tenant.integrationSecret);
    expect(raw).not.toContain(tenant.apiToken);
    const hashes = await ownerPool().query<{ password_hash: string }>('SELECT password_hash FROM users WHERE tenant_id = $1', [
      tenant.tenantId,
    ]);
    for (const { password_hash } of hashes.rows) expect(raw).not.toContain(password_hash);

    // Contagens conferem com o banco.
    const count = async (table: string) =>
      (await ownerPool().query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenant.tenantId])).rows[0].n;
    for (const table of ['bank_transactions', 'ledger_entries', 'matches', 'import_batches']) {
      expect(result.tables[table], table).toBe(await count(table));
    }
    // A própria exportação fica registrada na trilha da empresa, depois da fotografia exportada.
    expect(result.tables.audit_log).toBe((await count('audit_log')) - 1);
    const last = await ownerPool().query(
      'SELECT action, metadata FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1',
      [tenant.tenantId],
    );
    expect(last.rows[0]).toMatchObject({ action: 'tenant.data_exported', metadata: { rows: result.rows } });
    expect(lines.at(-1)!.tables).toEqual(result.tables);
  });

  it('com includeFiles traz os arquivos originais em base64', async () => {
    const out = join(dir, `${tenant.slug}-arquivos.ndjson`);
    const result = await exportTenant({ connectionString: OWNER_URL(), slug: tenant.slug, out, includeFiles: true });
    const { lines } = await readLines(out);
    const files = lines.filter((line) => line.type === 'row' && line.table === 'import_files');
    expect(files.length).toBe(result.tables.import_files);
    expect(files.length).toBeGreaterThan(0);
    expect(Buffer.from(String(files[0]!.data!.content), 'base64').toString('latin1')).toMatch(/OFXHEADER|ID;Data/);
  });

  it('não sobrescreve arquivo existente', async () => {
    const out = join(dir, `${tenant.slug}.ndjson`);
    await expect(exportTenant({ connectionString: OWNER_URL(), slug: tenant.slug, out })).rejects.toThrow(/já existe/);
  });
});
