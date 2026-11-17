import type { Db } from '../db/context';
import type { JobRecord } from './types';

export interface EnqueueInput {
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  /** Única por empresa e tipo: a mesma operação enfileirada duas vezes resulta em um só trabalho. */
  idempotencyKey: string;
  maxAttempts?: number;
  createdBy?: string | null;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 10 * 60_000;

/**
 * Enfileira um trabalho na transação corrente: ele só fica visível ao trabalhador se a operação
 * que o originou for confirmada. Em conflito de chave devolve o trabalho existente.
 */
export async function enqueue(db: Db, input: EnqueueInput): Promise<{ job: JobRecord; created: boolean }> {
  const inserted = await db.query<JobRecord>(
    `INSERT INTO jobs (tenant_id, type, payload, idempotency_key, max_attempts, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, type, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      input.tenantId,
      input.type,
      JSON.stringify(input.payload),
      input.idempotencyKey,
      input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      input.createdBy ?? null,
    ],
  );
  if (inserted.rows[0]) return { job: inserted.rows[0], created: true };
  const existing = await findJobByKey(db, input.tenantId, input.type, input.idempotencyKey);
  if (!existing) throw new Error('Trabalho existente não encontrado após conflito de chave');
  return { job: existing, created: false };
}

export async function findJobByKey(
  db: Db,
  tenantId: string,
  type: string,
  idempotencyKey: string,
): Promise<JobRecord | null> {
  const result = await db.query<JobRecord>(
    'SELECT * FROM jobs WHERE tenant_id = $1 AND type = $2 AND idempotency_key = $3',
    [tenantId, type, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

/**
 * Devolve à fila um trabalho já encerrado (concluído, morto ou cancelado), com as tentativas zeradas.
 * Usado no reprocessamento e na repetição manual. Nulo se o trabalho ainda está na fila ou rodando.
 */
export async function requeueJob(db: Db, tenantId: string, jobId: string): Promise<JobRecord | null> {
  const result = await db.query<JobRecord>(
    `UPDATE jobs
        SET status = 'queued', attempts = 0, run_at = now(), locked_at = NULL, locked_by = NULL,
            finished_at = NULL
      WHERE tenant_id = $1 AND id = $2 AND status IN ('succeeded', 'dead', 'canceled')
      RETURNING *`,
    [tenantId, jobId],
  );
  return result.rows[0] ?? null;
}

/** Espera antes da próxima tentativa: 2^tentativas × 5 s, no máximo 10 minutos. */
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(attempts, 0) * BASE_RETRY_MS, MAX_RETRY_MS);
}

export function jobView(row: JobRecord) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at.toISOString(),
    lastError: row.last_error,
    result: row.result ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}
