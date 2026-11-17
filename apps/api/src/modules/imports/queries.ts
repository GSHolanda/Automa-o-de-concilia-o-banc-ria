import type { Db } from '../../db/context';
import { gone, notFound } from '../../http/errors';
import type { FileFormat, SourceKind } from './files';

export const IMPORT_JOB_TYPE = 'import.process';

export type BatchStatus =
  | 'uploaded'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'canceled';

export interface ImportStats {
  totalRows: number;
  imported: number;
  duplicates: number;
  rejected: number;
  conflicts: number;
  skipped: number;
  duplicateSuspects: number;
  periodStart: string | null;
  periodEnd: string | null;
}

/** Configuração gravada no lote na confirmação: o mapeamento efetivamente usado. */
export interface BatchConfig {
  mapping: unknown;
  allowAccountMismatch: boolean;
}

export interface BatchRow {
  id: string;
  tenant_id: string;
  source_kind: SourceKind;
  bank_account_id: string | null;
  bank_account_name: string | null;
  profile_id: string | null;
  origin: string;
  file_name: string;
  file_format: FileFormat;
  file_sha256: string;
  file_size: number;
  status: BatchStatus;
  config: BatchConfig | null;
  stats: Partial<ImportStats>;
  error: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  processed_at: Date | null;
  file_purged_at: Date | null;
  cursor_at: string;
  job_id: string | null;
  job_status: string | null;
  job_attempts: number | null;
  job_last_error: string | null;
}

export const BATCH_SELECT = `
  SELECT b.*, a.name AS bank_account_name, b.created_at::text AS cursor_at,
         j.id AS job_id, j.status AS job_status, j.attempts AS job_attempts, j.last_error AS job_last_error
    FROM import_batches b
    LEFT JOIN bank_accounts a ON a.tenant_id = b.tenant_id AND a.id = b.bank_account_id
    LEFT JOIN jobs j ON j.tenant_id = b.tenant_id AND j.type = '${IMPORT_JOB_TYPE}' AND j.idempotency_key = b.id::text`;

export function batchView(row: BatchRow) {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    bankAccountId: row.bank_account_id,
    bankAccountName: row.bank_account_name,
    profileId: row.profile_id,
    origin: row.origin,
    fileName: row.file_name,
    fileFormat: row.file_format,
    fileSha256: row.file_sha256,
    fileSize: row.file_size,
    status: row.status,
    config: row.config,
    stats: row.stats,
    error: row.error,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    processedAt: row.processed_at?.toISOString() ?? null,
    filePurgedAt: row.file_purged_at?.toISOString() ?? null,
    job: row.job_id
      ? { id: row.job_id, status: row.job_status, attempts: row.job_attempts, lastError: row.job_last_error }
      : null,
  };
}

export async function findBatch(db: Db, tenantId: string, id: string, forUpdate = false): Promise<BatchRow> {
  // FOR UPDATE OF b: trava só o lote, não as tabelas da junção.
  const result = await db.query<BatchRow>(
    `${BATCH_SELECT} WHERE b.tenant_id = $1 AND b.id = $2${forUpdate ? ' FOR UPDATE OF b' : ''}`,
    [tenantId, id],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Importação não encontrada.');
  return row;
}

/** Recusa com 410 quando o arquivo original do lote foi expurgado pela política de retenção. */
export function assertFileNotPurged(batch: Pick<BatchRow, 'file_purged_at'>, action: string): void {
  if (!batch.file_purged_at) return;
  const date = batch.file_purged_at.toISOString().slice(0, 10);
  throw gone(
    `O arquivo original foi expurgado em ${date} pela política de retenção de arquivos da empresa; não é possível ${action}. ` +
      'O lote, o hash e as estatísticas continuam disponíveis.',
    'file_purged',
    { filePurgedAt: batch.file_purged_at.toISOString() },
  );
}

export async function loadBatchFile(db: Db, tenantId: string, batchId: string): Promise<Buffer | null> {
  const result = await db.query<{ content: Buffer }>(
    'SELECT content FROM import_files WHERE tenant_id = $1 AND batch_id = $2',
    [tenantId, batchId],
  );
  return result.rows[0]?.content ?? null;
}

export interface BankAccountRow {
  id: string;
  name: string;
  account_number: string | null;
  external_ref: string | null;
  active: boolean;
}

export async function findBankAccount(db: Db, tenantId: string, id: string): Promise<BankAccountRow | null> {
  const result = await db.query<BankAccountRow>(
    'SELECT id, name, account_number, external_ref, active FROM bank_accounts WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  );
  return result.rows[0] ?? null;
}

export interface ProfileRow {
  id: string;
  name: string;
  source_kind: SourceKind;
  file_format: 'csv' | 'xlsx';
  config: unknown;
  active: boolean;
}

export async function findProfile(db: Db, tenantId: string, id: string): Promise<ProfileRow | null> {
  const result = await db.query<ProfileRow>(
    'SELECT id, name, source_kind, file_format, config, active FROM import_profiles WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  );
  return result.rows[0] ?? null;
}
