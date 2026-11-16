import type { AuditActor, AuditEntry } from '../audit/audit';
import type { Db } from '../db/context';
import type { AppDeps } from '../deps';

/** O que o trabalhador precisa da aplicação. A API e o processo do trabalhador fornecem o mesmo conjunto. */
export type JobDeps = Pick<AppDeps, 'config' | 'pool' | 'metrics' | 'log'>;

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'dead' | 'canceled';

export interface JobRecord {
  id: string;
  tenant_id: string;
  type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  result: unknown;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export type JobAuditInput = Omit<AuditEntry, 'tenantId' | 'actor' | 'requestId' | 'ip'> & { actor?: AuditActor };

export interface JobContext {
  /** Transação própria do trabalho, no contexto da empresa dona. */
  db: Db;
  job: JobRecord;
  tenantId: string;
  deps: JobDeps;
  /** Auditoria com o trabalhador como autor, na transação do trabalho. */
  audit: (entry: JobAuditInput) => Promise<void>;
}

/** O que existe dentro de uma transação curta de um trabalho em etapas. */
export type JobTransactionScope = Pick<JobContext, 'db' | 'audit'>;

/**
 * Contexto de trabalho em etapas: nenhuma transação fica aberta durante chamadas a serviços externos.
 * Cada `transaction(...)` é uma transação curta no contexto da empresa dona.
 */
export interface StepsJobContext extends Omit<JobContext, 'db' | 'audit'> {
  transaction: <T>(fn: (scope: JobTransactionScope) => Promise<T>) => Promise<T>;
}

interface JobHandlerBase {
  /** Chamado na transação que marca o trabalho como morto (ex.: marcar o lote como falho). */
  onDead?: (db: Db, job: JobRecord, error: string) => Promise<void>;
  /** Chamado na transação que devolve um trabalho morto à fila por pedido de uma pessoa. */
  onRetry?: (db: Db, job: JobRecord) => Promise<void>;
}

/**
 * Manipulador de um tipo de trabalho. Deve ser idempotente: pode rodar de novo depois de uma falha
 * ou de um reprocessamento sem duplicar efeitos.
 */
export interface TransactionJobHandler extends JobHandlerBase {
  transaction?: 'job';
  /** Executa o trabalho em uma transação. O valor devolvido é gravado em `jobs.result`. Lançar erro conta como tentativa falha. */
  run: (context: JobContext) => Promise<unknown>;
}

/** Manipulador que chama serviço externo: grava em transações curtas antes e depois da chamada. */
export interface StepsJobHandler extends JobHandlerBase {
  transaction: 'steps';
  run: (context: StepsJobContext) => Promise<unknown>;
}

export type JobHandler = TransactionJobHandler | StepsJobHandler;

export const WORKER_ACTOR: AuditActor = { type: 'system', id: null, label: 'trabalhador' };
