import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { writeAudit } from '../audit/audit';
import { withContext, type Db } from '../db/context';
import { retryDelayMs } from './queue';
import { getJobHandler } from './registry';
import { WORKER_ACTOR, type JobDeps, type JobRecord } from './types';

export type JobOutcome = 'succeeded' | 'retried' | 'dead';

export interface RunSummary {
  processed: number;
  succeeded: number;
  retried: number;
  dead: number;
}

const ERROR_LIMIT = 2_000;
/** Intervalo mínimo entre duas liberações de trabalhos travados. */
const RELEASE_INTERVAL_MS = 30_000;

export function newWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || 'Erro sem mensagem').slice(0, ERROR_LIMIT);
}

/** Captura trabalhos prontos de qualquer empresa (função SECURITY DEFINER; não expõe outros dados). */
export async function claimJobs(deps: JobDeps, workerId: string, limit: number): Promise<JobRecord[]> {
  const result = await deps.pool.query<JobRecord>('SELECT * FROM jobs_claim($1, $2)', [workerId, limit]);
  return result.rows;
}

export async function releaseStaleJobs(deps: JobDeps): Promise<number> {
  const result = await deps.pool.query<{ released: number }>('SELECT jobs_release_stale($1) AS released', [
    deps.config.jobTimeoutSeconds,
  ]);
  return result.rows[0]?.released ?? 0;
}

/** Aviso interno a quem administra a empresa. */
async function notifyDead(db: Db, job: JobRecord, error: string): Promise<void> {
  await db.query(
    `INSERT INTO notifications (tenant_id, user_id, event, title, body, link)
     SELECT u.tenant_id, u.id, 'job.dead', $2, $3, '/importacoes'
       FROM users u
       JOIN roles r ON r.id = u.role_id AND r.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1 AND u.status = 'active' AND 'settings.manage' = ANY (r.permissions)`,
    [
      job.tenant_id,
      'Trabalho em falha definitiva',
      `O trabalho ${job.type} falhou ${job.attempts} vez(es) e não será repetido automaticamente: ${error.slice(0, 500)}`,
    ],
  );
}

async function markFailed(deps: JobDeps, job: JobRecord, workerId: string, error: string): Promise<JobOutcome> {
  const handler = getJobHandler(job.type);
  return withContext(deps.pool, { tenantId: job.tenant_id }, async (db) => {
    if (job.attempts < job.max_attempts) {
      await db.query(
        `UPDATE jobs
            SET status = 'queued', last_error = $3, run_at = now() + make_interval(secs => $4),
                locked_at = NULL, locked_by = NULL
          WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND locked_by = $5`,
        [job.tenant_id, job.id, error, retryDelayMs(job.attempts) / 1000, workerId],
      );
      return 'retried';
    }
    const updated = await db.query(
      `UPDATE jobs
          SET status = 'dead', last_error = $3, finished_at = now(), locked_at = NULL, locked_by = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND locked_by = $4`,
      [job.tenant_id, job.id, error, workerId],
    );
    if ((updated.rowCount ?? 0) === 0) return 'dead';
    await writeAudit(db, {
      tenantId: job.tenant_id,
      actor: WORKER_ACTOR,
      action: 'job.dead',
      entityType: 'job',
      entityId: job.id,
      summary: `Trabalho ${job.type} encerrado após ${job.attempts} tentativa(s)`,
      metadata: { type: job.type, attempts: job.attempts, error },
    });
    await notifyDead(db, job, error);
    if (handler?.onDead) {
      // Falha no complemento não impede registrar o trabalho como morto.
      await db.query('SAVEPOINT job_on_dead');
      try {
        await handler.onDead(db, job, error);
        await db.query('RELEASE SAVEPOINT job_on_dead');
      } catch (hookError) {
        await db.query('ROLLBACK TO SAVEPOINT job_on_dead');
        deps.log.error({ err: hookError, jobId: job.id, type: job.type }, 'falha ao concluir trabalho morto');
      }
    }
    return 'dead';
  });
}

/**
 * Executa um trabalho capturado. O manipulador roda em transação própria no contexto da empresa;
 * a atualização de situação do trabalho vem depois, em outra transação, para que uma falha do
 * manipulador (desfeita por inteiro) ainda seja registrada.
 */
export async function processJob(deps: JobDeps, job: JobRecord, workerId: string): Promise<JobOutcome> {
  const started = performance.now();
  let outcome: JobOutcome;
  try {
    const handler = getJobHandler(job.type);
    if (!handler) throw new Error(`Tipo de trabalho desconhecido: ${job.type}`);
    const result = await withContext(
      deps.pool,
      { tenantId: job.tenant_id, userId: job.created_by },
      (db) =>
        handler.run({
          db,
          job,
          tenantId: job.tenant_id,
          deps,
          audit: (entry) => writeAudit(db, { ...entry, tenantId: job.tenant_id, actor: entry.actor ?? WORKER_ACTOR }),
        }),
    );
    await withContext(deps.pool, { tenantId: job.tenant_id }, (db) =>
      db.query(
        `UPDATE jobs
            SET status = 'succeeded', result = $3, last_error = NULL, finished_at = now(),
                locked_at = NULL, locked_by = NULL
          WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND locked_by = $4`,
        [job.tenant_id, job.id, JSON.stringify(result ?? null), workerId],
      ),
    );
    outcome = 'succeeded';
  } catch (error) {
    const message = errorText(error);
    deps.log.warn({ jobId: job.id, type: job.type, attempts: job.attempts, error: message }, 'trabalho falhou');
    outcome = await markFailed(deps, job, workerId, message);
  }
  deps.metrics.jobsProcessed.inc({ type: job.type, result: outcome });
  deps.metrics.jobDuration.observe({ type: job.type }, (performance.now() - started) / 1000);
  return outcome;
}

/**
 * Drena a fila de forma síncrona: processa, em sequência, todos os trabalhos prontos até não restar
 * nenhum. Trabalhos que falharam voltam com espera e não são repetidos na mesma chamada.
 */
export async function runPendingJobs(
  deps: JobDeps,
  options: { workerId?: string; maxJobs?: number } = {},
): Promise<RunSummary> {
  const workerId = options.workerId ?? newWorkerId();
  const maxJobs = options.maxJobs ?? 1_000;
  const summary: RunSummary = { processed: 0, succeeded: 0, retried: 0, dead: 0 };
  await releaseStaleJobs(deps);
  while (summary.processed < maxJobs) {
    const [job] = await claimJobs(deps, workerId, 1);
    if (!job) break;
    const outcome = await processJob(deps, job, workerId);
    summary.processed += 1;
    summary[outcome] += 1;
  }
  return summary;
}

export interface WorkerHandle {
  readonly workerId: string;
  /** Para de capturar trabalhos e espera os que estão em andamento. */
  stop: () => Promise<void>;
}

/** Trabalhador contínuo: consulta a fila a cada `workerPollMs` e roda até `workerConcurrency` trabalhos por vez. */
export function startWorker(deps: JobDeps, options: { workerId?: string } = {}): WorkerHandle {
  const workerId = options.workerId ?? newWorkerId();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();
  let lastRelease = 0;

  const tick = async (): Promise<void> => {
    let claimed = 0;
    try {
      if (Date.now() - lastRelease >= RELEASE_INTERVAL_MS) {
        lastRelease = Date.now();
        const released = await releaseStaleJobs(deps);
        if (released > 0) deps.log.warn({ released }, 'trabalhos travados devolvidos à fila');
      }
      const jobs = await claimJobs(deps, workerId, deps.config.workerConcurrency);
      claimed = jobs.length;
      await Promise.all(jobs.map((job) => processJob(deps, job, workerId)));
    } catch (error) {
      deps.log.error({ err: error }, 'falha no ciclo do trabalhador');
    }
    if (!stopped) timer = setTimeout(schedule, claimed > 0 ? 0 : deps.config.workerPollMs);
  };
  const schedule = () => {
    current = tick();
  };

  timer = setTimeout(schedule, 0);
  deps.log.info({ workerId }, 'trabalhador da fila iniciado');

  return {
    workerId,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
      deps.log.info({ workerId }, 'trabalhador da fila parado');
    },
  };
}
