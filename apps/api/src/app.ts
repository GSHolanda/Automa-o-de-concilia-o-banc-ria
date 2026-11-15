import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import type { Config } from './config/env';
import { assertSafeRuntimeRole } from './db/context';
import { currentSchemaVersion, expectedSchemaVersion } from './db/migrate';
import { createPool } from './db/pool';
import type { AppDeps } from './deps';
import { AppError, fromDatabaseError } from './http/errors';
import { API_PREFIX, buildOpenApi, registerRoutes } from './http/route';
import { createMetrics } from './observability/metrics';
import { routes } from './routes';
import { hashPassword } from './security/password';
import { safeEqual } from './security/tokens';

// Mensagens de validação em português.
z.config(z.locales.ptBR());

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

function errorBody(code: string, message: string, requestId: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }), requestId } };
}

/** Erros do próprio Fastify e de plugins (JSON malformado, corpo grande demais, limite de requisições). */
function frameworkError(error: FastifyError): AppError | null {
  const status = error.statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;
  switch (status) {
    case 413:
      return new AppError(413, 'payload_too_large', 'O conteúdo enviado excede o tamanho permitido.');
    case 415:
      return new AppError(415, 'unsupported_media_type', 'Tipo de conteúdo não suportado.');
    case 429:
      return new AppError(429, 'rate_limited', 'Muitas tentativas. Aguarde um pouco e tente novamente.');
    case 404:
      return new AppError(404, 'not_found', 'Recurso não encontrado.');
    default:
      return new AppError(status, 'bad_request', 'Requisição inválida.');
  }
}

/** Converte o erro em resposta prevista; nulo quando é um erro inesperado (500). */
function toAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  if (error instanceof z.ZodError) {
    const details = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return new AppError(400, 'validation_error', 'Dados inválidos.', details);
  }
  return fromDatabaseError(error) ?? frameworkError(error as FastifyError);
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.secret',
          '*.token',
        ],
        censor: '[omitido]',
      },
    },
    genReqId: () => randomUUID(),
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  const pool = createPool(config.databaseUrl, config.dbPoolMax);
  app.addHook('onClose', async () => {
    await pool.end();
  });

  try {
    await assertSafeRuntimeRole(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }

  const { registry, metrics } = createMetrics(pool, config.nodeEnv !== 'test');
  const deps: AppDeps = {
    config,
    pool,
    version: pkg.version,
    metrics,
    registry,
    dummyPasswordHash: await hashPassword(randomBytes(24).toString('base64url'), config.passwordScryptCost),
    routes: [],
    log: {
      info: (object, message) => app.log.info(object, message),
      warn: (object, message) => app.log.warn(object, message),
      error: (object, message) => app.log.error(object, message),
    },
  };

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        ...(config.cookieSecure ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () =>
      new AppError(429, 'rate_limited', 'Muitas tentativas. Aguarde um pouco e tente novamente.'),
  });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });

  app.addHook('onResponse', async (req, reply) => {
    metrics.httpDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? 'desconhecida', status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  // Manipuladores síncronos: enviam a resposta e não devolvem o objeto reply.
  app.setErrorHandler((error, req, reply) => {
    const known = toAppError(error);
    if (!known) req.log.error({ err: error }, 'erro não tratado');
    const sent = known ?? new AppError(500, 'internal_error', 'Erro interno. Tente novamente mais tarde.');
    void reply.code(sent.status).send(errorBody(sent.code, sent.message, req.id, sent.details));
  });

  // Infraestrutura (fora do prefixo da API)
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    let database: 'ok' | 'error' = 'error';
    let schema: 'ok' | 'outdated' | 'unknown' = 'unknown';
    try {
      await pool.query('SELECT 1');
      database = 'ok';
      const [current, expected] = await Promise.all([currentSchemaVersion(pool), expectedSchemaVersion()]);
      schema = current !== null && current === expected ? 'ok' : 'outdated';
    } catch (error) {
      app.log.warn({ err: error }, 'verificação de prontidão falhou');
    }
    const ok = database === 'ok' && schema === 'ok';
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable', database, schema });
  });

  app.get('/metrics', async (req, reply) => {
    if (config.metricsToken) {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!safeEqual(token, config.metricsToken)) {
        throw new AppError(401, 'unauthenticated', 'Token de métricas ausente ou inválido.');
      }
    }
    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });

  registerRoutes(app, deps, routes);

  app.get(`${API_PREFIX}/openapi.json`, async () => buildOpenApi(deps));

  // Interface web compilada, com retorno ao index.html para as rotas do navegador.
  const webDir = config.webDistDir ? resolve(config.webDistDir) : null;
  const serveWeb = webDir !== null && existsSync(resolve(webDir, 'index.html'));
  if (webDir && !serveWeb) app.log.warn({ webDir }, 'WEB_DIST_DIR não contém index.html; interface web desativada');
  if (serveWeb) {
    await app.register(fastifyStatic, { root: webDir, wildcard: true, index: ['index.html'] });
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    const isApi = path === API_PREFIX || path.startsWith(`${API_PREFIX}/`) || path.startsWith('/api/');
    if (serveWeb && req.method === 'GET' && !isApi) {
      void reply.header('cache-control', 'no-cache').sendFile('index.html');
      return;
    }
    void reply.code(404).send(errorBody('not_found', 'Recurso não encontrado.', req.id));
  });

  return app;
}
