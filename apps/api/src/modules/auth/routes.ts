import { DEFAULT_TENANT_SETTINGS } from '@concilia/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit, type AuditActor } from '../../audit/audit';
import { withContext, type Db } from '../../db/context';
import type { AppDeps } from '../../deps';
import { AppError, badRequest, forbidden, notFound } from '../../http/errors';
import type { AuthContext } from '../../http/auth';
import { noContent, route, SESSION_COOKIE, type AuditInput, type RouteDefinition, type StatusResponse } from '../../http/route';
import { hashPassword, passwordProblem, verifyPassword } from '../../security/password';
import { csrfTokenFor, generateToken, sha256 } from '../../security/tokens';
import { getTenantSettings } from '../settings/service';
import { loadEntitlements } from '../tenancy/entitlements';

/** Inatividade máxima das sessões do operador da plataforma, que não tem configuração de empresa. */
const PLATFORM_IDLE_MINUTES = 60;
/** Tamanho mínimo de senha do operador da plataforma (igual ao exigido na criação pela CLI). */
const PLATFORM_PASSWORD_MIN_LENGTH = 12;

interface LoginUserRow {
  id: string;
  tenant_id: string | null;
  role_id: string | null;
  email: string;
  name: string;
  password_hash: string;
  status: string;
  is_platform_admin: boolean;
  must_change_password: boolean;
  failed_logins: number;
  locked_until: Date | null;
  tenant_status: string | null;
  password_changed_at: Date;
}

/** Validade da senha temporária (criação ou redefinição pelo administrador). */
export const TEMPORARY_PASSWORD_HOURS = 72;

/** Fim da espera do par usuário + origem, ou nulo. */
async function blockedUntil(deps: AppDeps, userId: string, source: string): Promise<Date | null> {
  const result = await deps.pool.query<{ until: Date | null }>('SELECT auth_login_blocked_until($1, $2) AS until', [
    userId,
    source,
  ]);
  return result.rows[0]?.until ?? null;
}

function throttled(until: Date): AppError {
  const seconds = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
  return new AppError(
    429,
    'login_throttled',
    `Muitas tentativas sem sucesso a partir desta origem. Aguarde ${seconds} segundo(s) e tente de novo.`,
  );
}

/** Corpo de /auth/me (e da resposta do login). */
export async function buildMe(db: Db, deps: AppDeps, userId: string, sessionId: string): Promise<Record<string, unknown>> {
  const found = await db.query<{
    id: string;
    name: string;
    email: string;
    must_change_password: boolean;
    is_platform_admin: boolean;
    tenant_id: string | null;
    role_key: string | null;
    role_name: string | null;
    permissions: string[] | null;
  }>(
    `SELECT u.id, u.name, u.email, u.must_change_password, u.is_platform_admin, u.tenant_id,
            r.key AS role_key, r.name AS role_name, r.permissions
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id AND r.tenant_id = u.tenant_id
      WHERE u.id = $1`,
    [userId],
  );
  const user = found.rows[0];
  if (!user) throw new AppError(401, 'unauthenticated', 'Autenticação necessária.');

  let tenant: Record<string, unknown> | null = null;
  let license: Record<string, unknown> | null = null;
  let modules: string[] = [];
  let branding = DEFAULT_TENANT_SETTINGS.branding;
  if (user.tenant_id) {
    const row = await db.query<{
      id: string;
      slug: string;
      trade_name: string;
      legal_name: string;
      status: string;
      onboarding: unknown;
    }>('SELECT id, slug, trade_name, legal_name, status, onboarding FROM tenants WHERE id = $1', [user.tenant_id]);
    const current = row.rows[0];
    if (current) {
      tenant = {
        id: current.id,
        slug: current.slug,
        tradeName: current.trade_name,
        legalName: current.legal_name,
        status: current.status,
        onboarding: current.onboarding,
      };
    }
    const entitlements = await loadEntitlements(db, user.tenant_id);
    modules = entitlements.modules;
    license = {
      planCode: entitlements.planCode,
      planName: entitlements.planName,
      status: entitlements.licenseStatus,
      validUntil: entitlements.validUntil,
      readOnly: entitlements.readOnly,
      readOnlyReason: entitlements.readOnlyReason,
      limits: entitlements.limits,
    };
    branding = (await getTenantSettings(db, user.tenant_id)).settings.branding;
  }

  return {
    // A marca de troca obrigatória só aparece quando pendente.
    user: { id: user.id, name: user.name, email: user.email, mustChangePassword: user.must_change_password },
    tenant,
    role: user.role_key ? { key: user.role_key, name: user.role_name } : null,
    permissions: user.permissions ?? [],
    modules,
    license,
    branding,
    csrfToken: csrfTokenFor(sessionId, deps.config.sessionSecret),
    isPlatformAdmin: user.is_platform_admin,
    productName: deps.config.productName,
    deploymentMode: deps.config.deploymentMode,
  };
}

function setSessionCookie(reply: FastifyReply, deps: AppDeps, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.config.cookieSecure,
    path: '/',
    maxAge: deps.config.sessionAbsoluteHours * 3600,
  });
}

const invalidCredentials = () => new AppError(401, 'invalid_credentials', 'E-mail ou senha inválidos.');

const loginBody = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

const sessionParams = z.object({ id: z.uuid() });

function loginRateKey(req: FastifyRequest): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return `login|${req.ip}|${typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : ''}`;
}

/** Grava a senha nova depois de conferida a atual; encerra as outras sessões. */
async function changePassword(
  db: Db,
  deps: AppDeps,
  auth: AuthContext,
  body: z.infer<typeof passwordBody>,
  current: { email: string },
  audit: (entry: AuditInput) => Promise<void>,
): Promise<StatusResponse> {
  const minLength = auth.tenantId
    ? (await getTenantSettings(db, auth.tenantId)).settings.security.passwordMinLength
    : PLATFORM_PASSWORD_MIN_LENGTH;
  const problem = passwordProblem(body.newPassword, { minLength }, current.email);
  if (problem) throw badRequest(problem, 'weak_password');
  if (body.newPassword === body.currentPassword) {
    throw badRequest('A nova senha deve ser diferente da atual.', 'weak_password');
  }

  await db.query(
    `UPDATE users
        SET password_hash = $2, must_change_password = false, password_changed_at = now()
      WHERE id = $1`,
    [auth.userId, await hashPassword(body.newPassword, deps.config.passwordScryptCost)],
  );
  const revoked = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed'
      WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [auth.userId, auth.sessionId],
  );
  await audit({
    action: 'auth.password_changed',
    entityType: 'user',
    entityId: auth.userId,
    summary: `${current.email} trocou a senha`,
    metadata: { revokedSessions: revoked.rowCount ?? 0 },
  });
  return noContent();
}

export const routes: RouteDefinition[] = [
  route({
    method: 'POST',
    url: '/auth/login',
    summary: 'Entrar com e-mail e senha',
    tags: ['autenticação'],
    auth: 'public',
    body: loginBody,
    // Por origem e e-mail: tentativas contra uma conta não barram o login de outras pessoas do mesmo IP.
    rateLimit: { max: 10, timeWindow: '1 minute', key: loginRateKey },
    handler: async ({ body, req, reply, deps }) => {
      const email = body.email.trim().toLowerCase();
      const found = await deps.pool.query<LoginUserRow>('SELECT * FROM auth_find_user($1)', [email]);
      const user = found.rows[0];
      if (!user) {
        // Mesmo custo de verificação que um usuário existente: o tempo não revela se o e-mail existe.
        await verifyPassword(body.password, deps.dummyPasswordHash);
        deps.metrics.loginAttempts.inc({ result: 'invalid' });
        throw invalidCredentials();
      }

      const context = { tenantId: user.tenant_id, userId: user.id, platform: user.is_platform_admin };
      const actor: AuditActor = { type: user.is_platform_admin ? 'platform' : 'user', id: user.id, label: user.name };
      const auditFailure = (db: Db, reason: string) =>
        writeAudit(db, {
          tenantId: user.tenant_id,
          actor,
          action: 'auth.login_failed',
          entityType: 'user',
          entityId: user.id,
          summary: `Tentativa de login sem sucesso para ${user.email}`,
          metadata: { reason, userAgent: req.headers['user-agent'] ?? null },
          requestId: req.id,
          ip: req.ip,
        });

      const passwordOk = await verifyPassword(body.password, user.password_hash);
      // Espera por conta e origem: falhas de um endereço não impedem o titular de entrar de outro.
      const until = await blockedUntil(deps, user.id, req.ip);
      if (until) {
        if (passwordOk) {
          // Só quem acerta a senha fica sabendo da espera; a trilha registra uma vez por tentativa certa.
          await withContext(deps.pool, context, (db) => auditFailure(db, 'throttled'));
          deps.metrics.loginAttempts.inc({ result: 'locked' });
          throw throttled(until);
        }
        deps.metrics.loginAttempts.inc({ result: 'invalid' });
        throw invalidCredentials();
      }

      if (!passwordOk) {
        await withContext(deps.pool, context, async (db) => {
          await db.query('SELECT auth_register_login_failure($1, $2, $3, $4)', [
            user.id,
            req.ip,
            deps.config.loginMaxAttempts,
            deps.config.loginLockMinutes,
          ]);
          await auditFailure(db, 'invalid_password');
        });
        deps.metrics.loginAttempts.inc({ result: 'invalid' });
        throw invalidCredentials();
      }

      if (user.status !== 'active') {
        deps.metrics.loginAttempts.inc({ result: 'disabled' });
        throw forbidden('Este usuário está desativado. Procure o administrador da empresa.', 'account_disabled');
      }
      if (user.tenant_id !== null && user.tenant_status === 'archived') {
        deps.metrics.loginAttempts.inc({ result: 'disabled' });
        throw forbidden('A empresa não está disponível.', 'tenant_unavailable');
      }
      if (
        user.must_change_password &&
        Date.now() - user.password_changed_at.getTime() > TEMPORARY_PASSWORD_HOURS * 3_600_000
      ) {
        deps.metrics.loginAttempts.inc({ result: 'disabled' });
        throw forbidden(
          `A senha temporária venceu (vale ${TEMPORARY_PASSWORD_HOURS} horas). Peça ao administrador uma nova.`,
          'temporary_password_expired',
        );
      }

      const token = generateToken();
      const me = await withContext(deps.pool, context, async (db) => {
        await db.query('SELECT auth_register_login_success($1, $2)', [user.id, req.ip]);
        const idleMinutes = user.tenant_id
          ? (await getTenantSettings(db, user.tenant_id)).settings.security.sessionIdleMinutes
          : PLATFORM_IDLE_MINUTES;
        const session = await db.query<{ id: string }>(
          `INSERT INTO sessions (user_id, tenant_id, token_hash, expires_at, idle_minutes, ip, user_agent)
           VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6, $7)
           RETURNING id`,
          [
            user.id,
            user.tenant_id,
            sha256(token),
            deps.config.sessionAbsoluteHours,
            idleMinutes,
            req.ip,
            (req.headers['user-agent'] ?? '').slice(0, 400) || null,
          ],
        );
        const sessionId = session.rows[0]!.id;
        await writeAudit(db, {
          tenantId: user.tenant_id,
          actor,
          action: 'auth.login',
          entityType: 'session',
          entityId: sessionId,
          summary: `${user.email} entrou`,
          metadata: { userAgent: req.headers['user-agent'] ?? null },
          requestId: req.id,
          ip: req.ip,
        });
        return buildMe(db, deps, user.id, sessionId);
      });

      deps.metrics.loginAttempts.inc({ result: 'success' });
      setSessionCookie(reply, deps, token);
      return me;
    },
  }),

  route({
    method: 'GET',
    url: '/auth/me',
    summary: 'Usuário autenticado, empresa, permissões e licença',
    tags: ['autenticação'],
    auth: 'any_session',
    permission: null,
    allowPendingPasswordChange: true,
    handler: async ({ db, auth, deps }) => buildMe(db, deps, auth.userId as string, auth.sessionId as string),
  }),

  route({
    method: 'POST',
    url: '/auth/logout',
    summary: 'Encerrar a sessão atual',
    tags: ['autenticação'],
    auth: 'any_session',
    permission: null,
    write: false,
    allowPendingPasswordChange: true,
    handler: async ({ db, auth, audit, reply }) => {
      await db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`,
        [auth.sessionId],
      );
      await audit({
        action: 'auth.logout',
        entityType: 'session',
        entityId: auth.sessionId,
        summary: `${auth.email ?? auth.name} saiu`,
      });
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return noContent();
    },
  }),

  route({
    method: 'POST',
    url: '/auth/password',
    summary: 'Trocar a própria senha',
    tags: ['autenticação'],
    auth: 'any_session',
    permission: null,
    write: false,
    allowPendingPasswordChange: true,
    body: passwordBody,
    rateLimit: { max: 10, timeWindow: '1 minute' },
    // A falha precisa ficar gravada mesmo com a recusa: transações curtas em vez de uma só.
    transaction: 'steps',
    handler: async ({ auth, body, deps, req, transaction }) => {
      const userId = auth.userId as string;
      const until = await blockedUntil(deps, userId, req.ip);
      if (until) throw throttled(until);
      const current = await transaction(async ({ db }) => {
        const row = await db.query<{ password_hash: string; email: string }>(
          'SELECT password_hash, email FROM users WHERE id = $1',
          [userId],
        );
        return row.rows[0];
      });
      if (!current || !(await verifyPassword(body.currentPassword, current.password_hash))) {
        // Conta como falha da origem, como no login: quem tem uma sessão roubada não testa senhas à vontade.
        await transaction(async ({ db, audit }) => {
          await db.query('SELECT auth_register_login_failure($1, $2, $3, $4)', [
            userId,
            req.ip,
            deps.config.loginMaxAttempts,
            deps.config.loginLockMinutes,
          ]);
          await audit({
            action: 'auth.password_change_failed',
            entityType: 'user',
            entityId: userId,
            summary: 'Troca de senha recusada: senha atual não confere',
          });
        });
        throw badRequest('A senha atual não confere.', 'invalid_password');
      }
      return transaction(({ db, audit }) => changePassword(db, deps, auth, body, current, audit));
    },
  }),
  route({
    method: 'GET',
    url: '/auth/sessions',
    summary: 'Sessões ativas do próprio usuário',
    tags: ['autenticação'],
    auth: 'any_session',
    permission: null,
    allowPendingPasswordChange: true,
    handler: async ({ db, auth }) => {
      const result = await db.query<{
        id: string;
        created_at: Date;
        last_seen_at: Date;
        expires_at: Date;
        ip: string | null;
        user_agent: string | null;
      }>(
        `SELECT id, created_at, last_seen_at, expires_at, ip, user_agent
           FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
            AND last_seen_at > now() - make_interval(mins => idle_minutes)
          ORDER BY created_at DESC`,
        [auth.userId],
      );
      return {
        items: result.rows.map((row) => ({
          id: row.id,
          createdAt: row.created_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
          ip: row.ip,
          userAgent: row.user_agent,
          current: row.id === auth.sessionId,
        })),
      };
    },
  }),

  route({
    method: 'DELETE',
    url: '/auth/sessions/:id',
    summary: 'Encerrar uma sessão do próprio usuário',
    tags: ['autenticação'],
    auth: 'any_session',
    permission: null,
    write: false,
    allowPendingPasswordChange: true,
    params: sessionParams,
    handler: async ({ db, auth, params, audit }) => {
      const result = await db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'revoked_by_user'
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
          RETURNING id`,
        [params.id, auth.userId],
      );
      if (result.rowCount === 0) throw notFound('Sessão não encontrada.');
      await audit({
        action: 'auth.session_revoked',
        entityType: 'session',
        entityId: params.id,
        summary: `${auth.email ?? auth.name} encerrou uma sessão`,
      });
      return noContent();
    },
  }),
];
