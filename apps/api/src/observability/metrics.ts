import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type pg from 'pg';

export interface Metrics {
  httpDuration: Histogram<'method' | 'route' | 'status'>;
  jobsProcessed: Counter<'type' | 'result'>;
  jobDuration: Histogram<'type'>;
  importRows: Counter<'source' | 'result'>;
  reconciliationMatches: Counter<'decision'>;
  loginAttempts: Counter<'result'>;
  integrationCalls: Counter<'kind' | 'result'>;
}

/** Registro próprio por instância da aplicação: evita colisão entre instâncias em testes. */
export function createMetrics(pool: pg.Pool, enableDefaults: boolean): { registry: Registry; metrics: Metrics } {
  const registry = new Registry();
  if (enableDefaults) collectDefaultMetrics({ register: registry, prefix: 'concilia_' });

  const metrics: Metrics = {
    httpDuration: new Histogram({
      name: 'concilia_http_request_duration_seconds',
      help: 'Duração das requisições HTTP',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    jobsProcessed: new Counter({
      name: 'concilia_jobs_processed_total',
      help: 'Trabalhos processados, por tipo e resultado',
      labelNames: ['type', 'result'],
      registers: [registry],
    }),
    jobDuration: new Histogram({
      name: 'concilia_job_duration_seconds',
      help: 'Duração dos trabalhos em fila',
      labelNames: ['type'],
      buckets: [0.05, 0.25, 1, 5, 15, 60, 300],
      registers: [registry],
    }),
    importRows: new Counter({
      name: 'concilia_import_rows_total',
      help: 'Linhas de importação por origem e resultado',
      labelNames: ['source', 'result'],
      registers: [registry],
    }),
    reconciliationMatches: new Counter({
      name: 'concilia_reconciliation_matches_total',
      help: 'Resultados do motor de conciliação, por decisão',
      labelNames: ['decision'],
      registers: [registry],
    }),
    loginAttempts: new Counter({
      name: 'concilia_login_attempts_total',
      help: 'Tentativas de login por resultado',
      labelNames: ['result'],
      registers: [registry],
    }),
    integrationCalls: new Counter({
      name: 'concilia_integration_calls_total',
      help: 'Chamadas a serviços externos por tipo e resultado',
      labelNames: ['kind', 'result'],
      registers: [registry],
    }),
  };

  // Profundidade e idade da fila, consultadas a cada coleta. Apenas contagens: nenhum dado de empresa.
  new Gauge({
    name: 'concilia_jobs_in_queue',
    help: 'Trabalhos por situação',
    labelNames: ['status'],
    registers: [registry],
    async collect() {
      this.reset();
      const result = await pool.query<{ status: string; total: string }>('SELECT status, total FROM ops_queue_stats()');
      for (const status of ['queued', 'running', 'dead']) this.set({ status }, 0);
      for (const row of result.rows) this.set({ status: row.status }, Number(row.total));
    },
  });
  new Gauge({
    name: 'concilia_jobs_oldest_queued_seconds',
    help: 'Idade do trabalho mais antigo aguardando na fila',
    registers: [registry],
    async collect() {
      const result = await pool.query<{ oldest_seconds: number }>(
        `SELECT oldest_seconds FROM ops_queue_stats() WHERE status = 'queued'`,
      );
      this.set(Number(result.rows[0]?.oldest_seconds ?? 0));
    },
  });

  return { registry, metrics };
}
