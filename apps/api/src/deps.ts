import type pg from 'pg';
import type { Registry } from 'prom-client';
import type { Config } from './config/env';
import type { RouteDefinition } from './http/route';
import type { Metrics } from './observability/metrics';

/** Dependências compartilhadas pela aplicação. Criadas uma vez em buildApp. */
export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  version: string;
  metrics: Metrics;
  registry: Registry;
  /** Hash de senha fictício: iguala o tempo de resposta do login para e-mails inexistentes. */
  dummyPasswordHash: string;
  /** Rotas registradas, usadas para gerar o OpenAPI. */
  routes: RouteDefinition[];
  log: {
    info: (object: Record<string, unknown>, message: string) => void;
    warn: (object: Record<string, unknown>, message: string) => void;
    error: (object: Record<string, unknown>, message: string) => void;
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Dependências da aplicação; usadas pelo trabalhador e pelos testes (ex.: runPendingJobs). */
    deps: AppDeps;
  }
}
