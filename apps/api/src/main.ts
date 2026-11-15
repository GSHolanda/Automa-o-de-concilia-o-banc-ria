import { buildApp } from './app';
import { ConfigError, loadConfig } from './config/env';

/** Prazo para concluir as requisições em andamento antes de encerrar à força. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'encerrando o servidor');
    const timer = setTimeout(() => {
      app.log.error({}, 'encerramento excedeu o prazo; saindo à força');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'falha ao encerrar');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(error.message);
  else console.error('Falha ao iniciar o servidor:', error);
  process.exit(1);
});
