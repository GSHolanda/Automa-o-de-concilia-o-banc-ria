import { ConfigError, loadConfig } from './config/env';
import { assertSafeRuntimeRole } from './db/context';
import { createPool } from './db/pool';
import { startWorker } from './jobs/worker';
import type { JobDeps } from './jobs/types';
import { createMetrics } from './observability/metrics';

const SHUTDOWN_TIMEOUT_MS = 30_000;

type Level = 'info' | 'warn' | 'error';

/** Registro em JSON de uma linha, no mesmo espírito do log da API. Erros entram só com nome e mensagem. */
function logLine(level: Level, object: Record<string, unknown>, message: string): void {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    fields[key] = value instanceof Error ? { name: value.name, message: value.message } : value;
  }
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Processo separado do trabalhador da fila (`pnpm worker`). */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.workerEnabled) {
    console.warn('WORKER_ENABLED=false: o trabalhador não será iniciado.');
    return;
  }
  const pool = createPool(config.databaseUrl, config.dbPoolMax);
  try {
    await assertSafeRuntimeRole(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const { metrics } = createMetrics(pool, false);
  const deps: JobDeps = {
    config,
    pool,
    metrics,
    log: {
      info: (object, message) => logLine('info', object, message),
      warn: (object, message) => logLine('warn', object, message),
      error: (object, message) => logLine('error', object, message),
    },
  };
  const worker = startWorker(deps);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logLine('info', { signal }, 'encerrando o trabalhador');
    const timer = setTimeout(() => {
      logLine('error', {}, 'encerramento excedeu o prazo; saindo à força');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    worker
      .stop()
      .then(() => pool.end())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          logLine('error', { err: error }, 'falha ao encerrar');
          process.exit(1);
        },
      );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
