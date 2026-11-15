import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  hasPermission,
  type ModuleKey,
  type PermissionKey,
  type TenantSettings,
} from '@concilia/core';
import { writeAudit, type AuditActor, type AuditEntry } from '../audit/audit';
import type { AppDeps } from '../deps';
import { withContext, type Db } from '../db/context';
import { loadEntitlements, type Entitlements } from '../modules/tenancy/entitlements';
import { getTenantSettings } from '../modules/settings/service';
import { csrfTokenFor, safeEqual } from '../security/tokens';
import { AppError, forbidden, unauthenticated } from './errors';
import { authenticateApiToken, authenticateSession, type AuthContext } from './auth';

export type AuthMode = 'public' | 'session' | 'platform' | 'api_token';
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface FileResponse {
  kind: 'file';
  filename: string;
  contentType: string;
  body: Buffer;
}
export interface StatusResponse {
  kind: 'status';
  status: number;
  body?: unknown;
}

export const created = (body: unknown): StatusResponse => ({ kind: 'status', status: 201, body });
export const accepted = (body: unknown): StatusResponse => ({ kind: 'status', status: 202, body });
export const noContent = (): StatusResponse => ({ kind: 'status', status: 204 });
export const file = (filename: string, contentType: string, body: Buffer): FileResponse => ({
  kind: 'file',
  filename,
  contentType,
  body,
});

export type AuditInput = Omit<AuditEntry, 'tenantId' | 'actor' | 'requestId' | 'ip'> & {
  tenantId?: string | null;
  actor?: AuditActor;
};

export interface RouteContext<P, Q, B> {
  /** Transação com o contexto da empresa (ou da plataforma) já definido. */
  db: Db;
  auth: AuthContext;
  /** Empresa do contexto. Lança erro em rotas de plataforma. */
  tenantId: string;
  params: P;
  query: Q;
  body: B;
  req: FastifyRequest;
  reply: FastifyReply;
  deps: AppDeps;
  /** Grava evidência na mesma transação da operação. */
  audit: (entry: AuditInput) => Promise<void>;
  entitlements: () => Promise<Entitlements>;
  settings: () => Promise<TenantSettings>;
}

export interface PublicRouteContext<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  req: FastifyRequest;
  reply: FastifyReply;
  deps: AppDeps;
}

interface RouteBase<P, Q, B> {
  method: Method;
  url: string;
  summary: string;
  tags: string[];
  params?: z.ZodType<P>;
  query?: z.ZodType<Q>;
  body?: z.ZodType<B>;
  /** Limite de requisições por IP nesta rota. */
  rateLimit?: { max: number; timeWindow: string };
  /** A rota recebe multipart/form-data; o corpo é lido pelo próprio manipulador. */
  multipart?: boolean;
}

export interface PublicRoute<P, Q, B> extends RouteBase<P, Q, B> {
  auth: 'public';
  handler: (context: PublicRouteContext<P, Q, B>) => Promise<unknown>;
}

export interface ProtectedRoute<P, Q, B> extends RouteBase<P, Q, B> {
  auth: 'session' | 'platform' | 'api_token';
  /** Permissão exigida do papel do usuário. Nulo: basta estar autenticado. */
  permission: PermissionKey | null;
  /** Escopo exigido do token de API. */
  scope?: string;
  /** Módulo opcional que precisa estar ativo para a empresa. */
  module?: ModuleKey;
  /** Operação de escrita: bloqueada quando a licença está inativa. Padrão: todo método diferente de GET. */
  write?: boolean;
  /** Permitida mesmo quando o usuário ainda precisa trocar a senha temporária. */
  allowPendingPasswordChange?: boolean;
  handler: (context: RouteContext<P, Q, B>) => Promise<unknown>;
}

export type RouteDefinition<P = unknown, Q = unknown, B = unknown> = PublicRoute<P, Q, B> | ProtectedRoute<P, Q, B>;

/** Preserva a inferência dos tipos de parâmetros, consulta e corpo a partir dos esquemas. */
export function route<P = unknown, Q = unknown, B = unknown>(definition: RouteDefinition<P, Q, B>): RouteDefinition {
  return definition as unknown as RouteDefinition;
}

export const API_PREFIX = '/api/v1';
export const SESSION_COOKIE = 'concilia_sid';

function actorOf(auth: AuthContext): AuditActor {
  if (auth.kind === 'api_token') return { type: 'api_token', id: auth.apiTokenId ?? null, label: auth.name };
  return { type: auth.isPlatformAdmin ? 'platform' : 'user', id: auth.userId, label: auth.name };
}

function parseWith<T>(schema: z.ZodType<T> | undefined, value: unknown): T {
  return schema ? schema.parse(value ?? {}) : (value as T);
}

function send(reply: FastifyReply, result: unknown): FastifyReply {
  if (result && typeof result === 'object' && 'kind' in result) {
    const typed = result as FileResponse | StatusResponse;
    if (typed.kind === 'file') {
      const safeName = typed.filename.replace(/[^A-Za-z0-9._-]/g, '_');
      return reply
        .header('content-type', typed.contentType)
        .header('content-disposition', `attachment; filename="${safeName}"`)
        .header('cache-control', 'no-store')
        .send(typed.body);
    }
    if (typed.kind === 'status') {
      return typed.body === undefined ? reply.code(typed.status).send() : reply.code(typed.status).send(typed.body);
    }
  }
  return reply.send(result ?? null);
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps, routes: readonly RouteDefinition[]): void {
  for (const definition of routes) {
    deps.routes.push(definition);
    app.route({
      method: definition.method,
      url: `${API_PREFIX}${definition.url}`,
      config: {
        ...(definition.rateLimit && deps.config.rateLimitEnabled ? { rateLimit: definition.rateLimit } : {}),
      },
      handler: async (req, reply) => {
        const params = parseWith(definition.params, req.params);
        const query = parseWith(definition.query, req.query);
        const body = definition.multipart ? (undefined as unknown) : parseWith(definition.body, req.body);

        if (definition.auth === 'public') {
          return send(reply, await definition.handler({ params, query, body, req, reply, deps }));
        }

        const auth =
          definition.auth === 'api_token'
            ? await authenticateApiToken(deps, req)
            : await authenticateSession(deps, req);

        if (definition.auth === 'platform') {
          if (!auth.isPlatformAdmin) throw forbidden('Rota restrita ao operador da plataforma.');
        } else if (auth.tenantId === null) {
          throw forbidden('Esta rota exige um usuário de empresa.');
        }

        if (auth.kind === 'session') {
          if (definition.method !== 'GET') {
            const header = req.headers['x-csrf-token'];
            const expected = csrfTokenFor(auth.sessionId as string, deps.config.sessionSecret);
            if (typeof header !== 'string' || !safeEqual(header, expected)) {
              throw new AppError(403, 'csrf_invalid', 'Requisição recusada: token CSRF ausente ou inválido.');
            }
          }
          if (auth.mustChangePassword && !definition.allowPendingPasswordChange) {
            throw new AppError(403, 'password_change_required', 'Troque a senha temporária para continuar.');
          }
          if (definition.permission && !auth.isPlatformAdmin && !hasPermission(auth.permissions, definition.permission)) {
            throw forbidden();
          }
        } else if (definition.scope && !(auth.scopes ?? []).includes(definition.scope)) {
          throw forbidden('O token de API não tem o escopo necessário.');
        }

        const context = {
          tenantId: definition.auth === 'platform' ? null : auth.tenantId,
          userId: auth.userId,
          platform: definition.auth === 'platform',
        };

        const result = await withContext(deps.pool, context, async (db) => {
          let entitlementsCache: Entitlements | undefined;
          let settingsCache: TenantSettings | undefined;
          const entitlements = async () => {
            entitlementsCache ??= await loadEntitlements(db, auth.tenantId as string);
            return entitlementsCache;
          };
          const settings = async () => {
            settingsCache ??= (await getTenantSettings(db, auth.tenantId as string)).settings;
            return settingsCache;
          };

          if (definition.auth !== 'platform') {
            const isWrite = definition.write ?? definition.method !== 'GET';
            if (isWrite || definition.module) {
              const current = await entitlements();
              if (definition.module && !current.modules.includes(definition.module)) {
                throw new AppError(403, 'module_disabled', 'Este módulo não está habilitado para a empresa.', {
                  module: definition.module,
                });
              }
              if (isWrite && current.readOnly) {
                throw new AppError(
                  403,
                  'license_inactive',
                  `A empresa está em modo somente leitura: ${current.readOnlyReason}. Consultas e exportações continuam disponíveis.`,
                );
              }
            }
          }

          if (auth.kind === 'session' && auth.sessionTouchDue) {
            await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [auth.sessionId]);
          }

          const audit = (entry: AuditInput) =>
            writeAudit(db, {
              ...entry,
              tenantId: entry.tenantId === undefined ? auth.tenantId : entry.tenantId,
              actor: entry.actor ?? actorOf(auth),
              requestId: req.id,
              ip: req.ip,
            });

          return definition.handler({
            db,
            auth,
            get tenantId(): string {
              if (auth.tenantId === null) throw unauthenticated();
              return auth.tenantId;
            },
            params,
            query,
            body,
            req,
            reply,
            deps,
            audit,
            entitlements,
            settings,
          });
        });

        return send(reply, result);
      },
    });
  }
}

// ---------------------------------------------------------------------------
// OpenAPI gerado das mesmas definições que validam as requisições
// ---------------------------------------------------------------------------

function jsonSchema(schema: z.ZodType | undefined): unknown {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return { type: 'object' };
  }
}

export function buildOpenApi(deps: AppDeps): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const definition of deps.routes) {
    const path = `${API_PREFIX}${definition.url}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const operation: Record<string, unknown> = {
      summary: definition.summary,
      tags: definition.tags,
      responses: {
        '200': { description: 'Sucesso' },
        '400': { description: 'Dados inválidos' },
        '401': { description: 'Não autenticado' },
        '403': { description: 'Sem permissão' },
        '404': { description: 'Não encontrado' },
        '409': { description: 'Conflito' },
      },
    };
    if (definition.auth !== 'public') {
      operation.security = definition.auth === 'api_token' ? [{ apiToken: [] }] : [{ session: [], csrf: [] }];
      operation['x-auth'] = definition.auth;
      if (definition.permission) operation['x-permission'] = definition.permission;
      if (definition.module) operation['x-module'] = definition.module;
      if (definition.scope) operation['x-scope'] = definition.scope;
    }
    const parameters: unknown[] = [];
    const paramSchema = jsonSchema(definition.params) as { properties?: Record<string, unknown> } | undefined;
    for (const [name, schema] of Object.entries(paramSchema?.properties ?? {})) {
      parameters.push({ name, in: 'path', required: true, schema });
    }
    const querySchema = jsonSchema(definition.query) as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    for (const [name, schema] of Object.entries(querySchema?.properties ?? {})) {
      parameters.push({ name, in: 'query', required: querySchema?.required?.includes(name) ?? false, schema });
    }
    if (parameters.length > 0) operation.parameters = parameters;
    if (definition.multipart) {
      operation.requestBody = { content: { 'multipart/form-data': { schema: { type: 'object' } } } };
    } else if (definition.body) {
      operation.requestBody = { content: { 'application/json': { schema: jsonSchema(definition.body) } } };
    }
    paths[path] = { ...(paths[path] ?? {}), [definition.method.toLowerCase()]: operation };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: `${deps.config.productName} — API`,
      version: deps.version,
      description:
        'API de conciliação bancária. Rotas de sessão usam cookie HttpOnly e o cabeçalho X-CSRF-Token em escritas. ' +
        'Rotas de integração usam token de API no cabeçalho Authorization: Bearer.',
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
        csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
        apiToken: { type: 'http', scheme: 'bearer' },
      },
    },
  };
}
