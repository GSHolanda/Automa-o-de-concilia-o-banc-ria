import { jobHandlers } from './handlers';
import type { JobHandler } from './types';

const registry = new Map<string, JobHandler>(Object.entries(jobHandlers));

/**
 * Registra (ou substitui) o manipulador de um tipo de trabalho. Devolve uma função que restaura
 * o manipulador anterior; útil em testes que simulam falhas.
 */
export function registerJobHandler(type: string, handler: JobHandler): () => void {
  const previous = registry.get(type);
  registry.set(type, handler);
  return () => {
    if (previous) registry.set(type, previous);
    else registry.delete(type);
  };
}

export function getJobHandler(type: string): JobHandler | undefined {
  return registry.get(type);
}
