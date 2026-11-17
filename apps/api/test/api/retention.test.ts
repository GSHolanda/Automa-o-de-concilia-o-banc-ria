import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PURGE_FILES_JOB_TYPE, scheduleMaintenanceJobs } from '../../src/jobs/maintenance';
import { buildTestApp, createTenant, loggedIn, type ApiClient, type TestTenant } from '../helpers/app';
import { appPool, closePools, ownerPool } from '../helpers/db';
import { buildOfx, createBankAccount, drainJobs, importFile, type TestBankAccount } from '../helpers/imports';

let app: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;
let admin: ApiClient;
let otherAdmin: ApiClient;
let account: TestBankAccount;
let otherAccount: TestBankAccount;

async function importOfx(client: ApiClient, target: TestBankAccount, tag: string) {
  const imported = await importFile(app, client, {
    sourceKind: 'bank',
    bankAccountId: target.id,
    fileName: `extrato-${tag}.ofx`,
    content: buildOfx({
      accountId: target.accountNumber ?? '0',
      transactions: [{ date: '2024-03-05', amount: '150,00', memo: `PIX RECEBIDO ${tag}`, fitId: `RET${tag}` }],
    }),
  });
  expect(imported.batch.status).toBe('completed');
  return imported;
}

/** Simula um lote processado há `days` dias. */
async function age(batchId: string, days: number) {
  await ownerPool().query(`UPDATE import_batches SET processed_at = now() - make_interval(days => $2) WHERE id = $1`, [
    batchId,
    days,
  ]);
}

async function fileExists(batchId: string): Promise<boolean> {
  const result = await ownerPool().query('SELECT 1 FROM import_files WHERE batch_id = $1', [batchId]);
  return (result.rowCount ?? 0) > 0;
}

async function purgeJobs(tenantId: string) {
  const result = await ownerPool().query<{ idempotency_key: string; status: string; result: any }>(
    'SELECT idempotency_key, status, result FROM jobs WHERE tenant_id = $1 AND type = $2 ORDER BY created_at',
    [tenantId, PURGE_FILES_JOB_TYPE],
  );
  return result.rows;
}

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'retencao' });
  other = await createTenant({ label: 'semretencao' });
  admin = await loggedIn(app, tenant.adminEmail);
  otherAdmin = await loggedIn(app, other.adminEmail);
  account = await createBankAccount(tenant.tenantId, { accountNumber: '11111-1' });
  otherAccount = await createBankAccount(other.tenantId, { accountNumber: '22222-2' });
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('retenção de arquivos originais', () => {
  let oldBatch: string;
  let recentBatch: string;
  let otherBatch: string;
  let statsBefore: unknown;

  it('agenda o expurgo só para empresas com retenção configurada, uma vez por dia', async () => {
    oldBatch = (await importOfx(admin, account, 'antigo')).batchId;
    recentBatch = (await importOfx(admin, account, 'recente')).batchId;
    otherBatch = (await importOfx(otherAdmin, otherAccount, 'outra')).batchId;
    await age(oldBatch, 45);
    await age(recentBatch, 10);
    await age(otherBatch, 400);
    statsBefore = (await admin.get(`/imports/${oldBatch}`)).body.stats;

    const settings = await admin.put('/settings', { patch: { imports: { originalFileRetentionDays: 30 } } });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);

    // A função de escopo mínimo devolve apenas ids, e só de empresas com retenção configurada.
    const listed = await appPool().query('SELECT * FROM maintenance_retention_tenants()');
    expect(Object.keys(listed.rows[0] ?? {})).toEqual(['tenant_id']);
    const ids = listed.rows.map((row) => row.tenant_id);
    expect(ids).toContain(tenant.tenantId);
    expect(ids).not.toContain(other.tenantId);

    const first = await scheduleMaintenanceJobs(app.deps, '2026-11-16');
    const again = await scheduleMaintenanceJobs(app.deps, '2026-11-16');
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(again.created).toBe(0);
    const jobs = await purgeJobs(tenant.tenantId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotency_key).toContain('2026-11-16');
    expect(await purgeJobs(other.tenantId)).toHaveLength(0);
  });

  it('remove o arquivo vencido, mantém lote, hash e estatísticas e grava auditoria com a quantidade', async () => {
    await drainJobs(app);
    const [job] = await purgeJobs(tenant.tenantId);
    expect(job!.status).toBe('succeeded');
    expect(job!.result).toMatchObject({ purged: 1, retentionDays: 30 });

    expect(await fileExists(oldBatch)).toBe(false);
    expect(await fileExists(recentBatch)).toBe(true);
    expect(await fileExists(otherBatch)).toBe(true);

    const batch = await admin.get(`/imports/${oldBatch}`);
    expect(batch.status).toBe(200);
    expect(batch.body.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(batch.body.stats).toEqual(statsBefore);
    expect(batch.body.status).toBe('completed');
    expect(batch.body.filePurgedAt).not.toBeNull();
    expect((await admin.get(`/imports/${recentBatch}`)).body.filePurgedAt).toBeNull();

    const audit = await ownerPool().query(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'import.files_purged'`,
      [tenant.tenantId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({ count: 1, retentionDays: 30 });
  });

  it('arquivo expurgado responde 410 no download, na prévia e no reprocessamento', async () => {
    const download = await admin.get(`/imports/${oldBatch}/file`);
    expect(download.status).toBe(410);
    expect(download.body.error.code).toBe('file_purged');
    expect(download.body.error.message).toMatch(/expurgado/);

    const reprocess = await admin.post(`/imports/${oldBatch}/reprocess`, {});
    expect(reprocess.status).toBe(410);
    expect((await admin.get(`/imports/${oldBatch}`)).body.stats).toEqual(statsBefore);

    expect((await admin.get(`/imports/${recentBatch}/file`)).status).toBe(200);
    // Lote de outra empresa continua 404.
    expect((await otherAdmin.get(`/imports/${oldBatch}/file`)).status).toBe(404);
  });

  it('rodar de novo não expurga nada a mais e nulo nunca expurga', async () => {
    await scheduleMaintenanceJobs(app.deps, '2026-11-17');
    await drainJobs(app);
    const jobs = await purgeJobs(tenant.tenantId);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]!.result).toMatchObject({ purged: 0 });
    expect(await fileExists(recentBatch)).toBe(true);

    const audit = await ownerPool().query(
      `SELECT count(*)::int AS total FROM audit_log WHERE tenant_id = $1 AND action = 'import.files_purged'`,
      [tenant.tenantId],
    );
    expect(audit.rows[0].total).toBe(1);
  });
});
