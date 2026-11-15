import { ConfigError, loadConfig } from './config/env';

/** Processo do trabalhador da fila. A fila de trabalhos é implementada na etapa E7. */
function main(): void {
  const config = loadConfig();
  if (!config.workerEnabled) {
    console.warn('WORKER_ENABLED=false: o trabalhador não será iniciado.');
    return;
  }
  console.warn('O trabalhador da fila ainda não está disponível nesta versão (chega na etapa E7). Nada a fazer.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}
