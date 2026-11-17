import { sanitizePermissions } from '@concilia/core';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/context';
import type { AuthContext } from '../../http/auth';
import { badRequest, conflict, forbidden, notFound } from '../../http/errors';
import { created, noContent, route, SESSION_COOKIE, type RouteDefinition } from '../../http/route';
import { generateTemporaryPassword, hashPassword, passwordProblem } from '../../security/password';
import { sha256 } from '../../security/tokens';
import type { Entitlements } from '../tenancy/entitlements';

// ---------------------------------------------------------------------------
// Consultas auxiliares
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'disabled';
  role_id: string;
  role_key: string;
  role_name: string;
  must_change_password: boolean;
  last_login_at: Date | null;
  locked_until: Date | null;
  created_at: Date;
  permissions: string[];
}

const USER_SELECT = `
  SELECT u.id, u.name, u.email, u.status, u.role_id, r.key AS role_key, r.name AS role_name,
         u.must_change_password, u.last_login_at, u.locked_until, u.created_at, r.permissions
    FROM users u
    JOIN roles r ON r.id = u.role_id AND r.tenant_id = u.tenant_id`;

function userView(row: UserRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status,
    roleId: row.role_id,
    roleKey: row.role_key,
    roleName: row.role_name,
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    lockedUntil: row.locked_until && row.locked_until.getTime() > Date.now() ? row.locked_until.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

async function findUser(db: Db, tenantId: string, id: string): Promise<UserRow> {
  const result = await db.query<UserRow>(`${USER_SELECT} WHERE u.tenant_id = $1 AND u.id = $2`, [tenantId, id]);
  const row = result.rows[0];
  if (!row) throw notFound('Usuário não encontrado.');
  return row;
}

interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string;
  is_system: boolean;
  permissions: string[];
  user_count: number;
  created_at: Date;
  updated_at: Date;
}

const ROLE_SELECT = `
  SELECT r.id, r.key, r.name, r.description, r.is_system, r.permissions, r.created_at, r.updated_at,
         (SELECT count(*)::int FROM users u WHERE u.tenant_id = r.tenant_id AND u.role_id = r.id) AS user_count
    FROM roles r`;

function roleView(row: RoleRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.is_system,
    permissions: row.permissions,
    userCount: row.user_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function findRole(db: Db, tenantId: string, id: string): Promise<RoleRow | null> {
  const result = await db.query<RoleRow>(`${ROLE_SELECT} WHERE r.tenant_id = $1 AND r.id = $2`, [tenantId, id]);
  return result.rows[0] ?? null;
}

/** Serializa as alterações de acesso da empresa, para que a regra do último administrador não seja burlada. */
async function lockTenantAccess(db: Db, tenantId: string): Promise<void> {
  await db.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
}

/** A empresa não pode ficar sem ao menos um usuário ativo que gerencie usuários. */
async function assertAdminRemains(db: Db, tenantId: string): Promise<void> {
  const result = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM users u
       JOIN roles r ON r.id = u.role_id AND r.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1 AND u.status = 'active' AND 'users.manage' = ANY (r.permissions)`,
    [tenantId],
  );
  if ((result.rows[0]?.total ?? 0) === 0) {
    throw conflict('A empresa precisa de ao menos um usuário ativo que gerencie usuários.', 'last_admin');
  }
}

async function assertUserLimit(db: Db, tenantId: string, entitlements: Entitlements): Promise<void> {
  const max = entitlements.limits.maxUsers;
  if (max === null) return;
  const result = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM users WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId],
  );
  if ((result.rows[0]?.total ?? 0) >= max) {
    throw forbidden(`O plano permite até ${max} usuários ativos.`, 'limit_reached');
  }
}

async function revokeUserSessions(db: Db, tenantId: string, userId: string, reason: string): Promise<number> {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $3
      WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tenantId, userId, reason],
  );
  return result.rowCount ?? 0;
}

/**
 * Quem gerencia acesso não concede o que não tem: as permissões do papel (ou do usuário alterado)
 * precisam estar contidas nas do autor. Impede que `users.manage` vire administrador por conta própria.
 */
function assertWithinActor(auth: AuthContext, permissions: readonly string[], message: string): void {
  const missing = permissions.filter((key) => !auth.permissions.includes(key));
  if (missing.length > 0) throw forbidden(message, 'permission_escalation');
}

const GRANT_MESSAGE = 'Você não pode conceder permissões que não tem.';
const TARGET_MESSAGE = 'Você não pode alterar o acesso de quem tem permissões que você não tem.';

/** Registra quem mexeu no acesso do usuário (criação, papel, situação, senha); usado pelos quatro olhos. */
async function markAccessChanged(db: Db, tenantId: string, where: { userId?: string; roleId?: string }, actorId: string | null) {
  await db.query(
    `UPDATE users SET access_changed_by = $4, access_changed_at = now()
      WHERE tenant_id = $1 AND (id = $2 OR role_id = $3)`,
    [tenantId, where.userId ?? null, where.roleId ?? null, actorId],
  );
}

/** Chave do limite por sessão (hash do cookie); sem cookie, pelo IP. */
function sessionRateKey(req: FastifyRequest): string {
  const token = req.cookies?.[SESSION_COOKIE];
  return token ? `users|${sha256(token).toString('hex')}` : `users|${req.ip}`;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === '23505' && pgError.constraint === constraint;
}

// ---------------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------------

const idParams = z.object({ id: z.uuid() });

const createUserBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  roleId: z.uuid(),
  password: z.string().min(1).max(200).optional(),
});

const updateUserBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  roleId: z.uuid().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const roleKey = z.string().regex(/^[a-z0-9_-]{2,40}$/, 'Use de 2 a 40 letras minúsculas, números, "-" ou "_".');

const createRoleBody = z.object({
  key: roleKey,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string().max(100)).max(100),
});

const updateRoleBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string().max(100)).max(100).optional(),
});

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------


export const routes: RouteDefinition[] = [
  route({
    tags: ['acesso'],
    auth: 'session',
    permission: 'users.manage',
    method: 'GET',
    url: '/users',
    summary: 'Listar usuários da empresa',
    handler: async ({ db, tenantId }) => {
      const result = await db.query<UserRow>(`${USER_SELECT} WHERE u.tenant_id = $1 ORDER BY lower(u.name), u.id`, [
        tenantId,
      ]);
      return { items: result.rows.map(userView) };
    },
  }),

  route({
    tags: ['acesso'],
    auth: 'session',
    permission: 'users.manage',
    method: 'POST',
    url: '/users',
    summary: 'Criar usuário',
    body: createUserBody,
    // O e-mail é único na instalação (ADR-03): o limite reduz a sondagem de e-mails de outras empresas.
    rateLimit: { max: 20, timeWindow: '10 minutes', key: sessionRateKey },
    handler: async ({ db, tenantId, auth, body, deps, audit, entitlements, settings }) => {
      await lockTenantAccess(db, tenantId);
      const role = await findRole(db, tenantId, body.roleId);
      if (!role) throw badRequest('Papel inexistente.', 'invalid_role');
      assertWithinActor(auth, role.permissions, GRANT_MESSAGE);
      await assertUserLimit(db, tenantId, await entitlements());

      const email = body.email.trim().toLowerCase();
      const temporaryPassword = body.password ? null : generateTemporaryPassword();
      const password = body.password ?? (temporaryPassword as string);
      if (body.password) {
        const problem = passwordProblem(password, { minLength: (await settings()).security.passwordMinLength }, email);
        if (problem) throw badRequest(problem, 'weak_password');
      }

      let id: string;
      try {
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO users (tenant_id, role_id, email, name, password_hash, must_change_password)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            tenantId,
            role.id,
            email,
            body.name,
            await hashPassword(password, deps.config.passwordScryptCost),
            temporaryPassword !== null,
          ],
        );
        id = inserted.rows[0]!.id;
        await markAccessChanged(db, tenantId, { userId: id }, auth.userId);
      } catch (error) {
        if (isUniqueViolation(error, 'users_email_unique')) {
          throw conflict('Já existe um usuário com este e-mail.', 'email_taken');
        }
        throw error;
      }

      await audit({
        action: 'user.created',
        entityType: 'user',
        entityId: id,
        summary: `Usuário ${email} criado com o papel ${role.name}`,
        after: { name: body.name, email, roleId: role.id, roleKey: role.key, status: 'active' },
        metadata: { mustChangeOnFirstLogin: temporaryPassword !== null },
      });
      return created(temporaryPassword ? { id, temporaryPassword } : { id });
    },
  }),

  route({
    tags: ['acesso'],
    auth: 'session',
    permission: 'users.manage',
    method: 'PATCH',
    url: '/users/:id',
    summary: 'Alterar nome, papel ou situação de um usuário',
    params: idParams,
    body: updateUserBody,
    handler: async ({ db, tenantId, auth, params, body, audit, entitlements }) => {
      await lockTenantAccess(db, tenantId);
      const before = await findUser(db, tenantId, params.id);
      const changesAccess = (body.roleId !== undefined && body.roleId !== before.role_id) || (body.status ?? before.status) !== before.status;
      if (changesAccess && params.id === auth.userId) {
        throw forbidden('Você não pode alterar o próprio papel nem a própria situação.', 'self_access');
      }
      if (changesAccess) assertWithinActor(auth, before.permissions, TARGET_MESSAGE);
      let roleId = before.role_id;
      if (body.roleId && body.roleId !== before.role_id) {
        const role = await findRole(db, tenantId, body.roleId);
        if (!role) throw badRequest('Papel inexistente.', 'invalid_role');
        assertWithinActor(auth, role.permissions, GRANT_MESSAGE);
        roleId = role.id;
      }
      const status = body.status ?? before.status;
      if (status === 'active' && before.status === 'disabled') await assertUserLimit(db, tenantId, await entitlements());

      await db.query(`UPDATE users SET name = $3, role_id = $4, status = $5 WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        params.id,
        body.name ?? before.name,
        roleId,
        status,
      ]);
      await assertAdminRemains(db, tenantId);
      if (changesAccess) await markAccessChanged(db, tenantId, { userId: params.id }, auth.userId);

      let revokedSessions = 0;
      if (status === 'disabled' && before.status !== 'disabled') {
        revokedSessions = await revokeUserSessions(db, tenantId, params.id, 'user_disabled');
      }
      const after = await findUser(db, tenantId, params.id);
      await audit({
        action: 'user.updated',
        entityType: 'user',
        entityId: params.id,
        summary: `Usuário ${after.email} alterado`,
        before: { name: before.name, roleId: before.role_id, roleKey: before.role_key, status: before.status },
        after: { name: after.name, roleId: after.role_id, roleKey: after.role_key, status: after.status },
        metadata: { revokedSessions },
      });
      return userView(after);
    },
  }),

  route({
    tags: ['acesso'],
    auth: 'session',
    permission: 'users.manage',
    method: 'POST',
    url: '/users/:id/reset-password',
    summary: 'Gerar senha temporária para um usuário',
    params: idParams,
    handler: async ({ db, tenantId, auth, params, deps, audit }) => {
      const user = await findUser(db, tenantId, params.id);
      assertWithinActor(auth, user.permissions, TARGET_MESSAGE);
      const temporaryPassword = generateTemporaryPassword();
      await db.query(
        `UPDATE users
            SET password_hash = $3, must_change_password = true, password_changed_at = now(),
                failed_logins = 0, locked_until = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, params.id, await hashPassword(temporaryPassword, deps.config.passwordScryptCost)],
      );
      await markAccessChanged(db, tenantId, { userId: params.id }, auth.userId);
      const revokedSessions = await revokeUserSessions(db, tenantId, params.id, 'password_reset');
      await audit({
        action: 'user.password_reset',
        entityType: 'user',
        entityId: params.id,
        summary: `Senha de ${user.email} redefinida`,
        metadata: { revokedSessions },
      });
      return { temporaryPassword };
    },
  }),

  route({
    tags: ['acesso'],
    auth: 'session',
    permission: 'users.manage',
    method: 'POST',
    url: '/users/:id/revoke-sessions',
    summary: 'Encerrar todas as sessões de um usuário',
    params: idParams,
    handler: async ({ db, tenantId, auth, params, audit }) => {
      const user = await findUser(db, tenantId, params.id);
      assertWithinActor(auth, user.permissions, TARGET_MESSAGE);
      const revokedSessions = await revokeUserSessions(db, tenantId, params.id, 'revoked_by_admin');
      await audit({
        action: 'user.sessions_revoked',
        entityType: 'user',
        entityId: params.id,
        summary: `Sessões de ${user.email} encerradas`,
        metadata: { revokedSessions },
      });
      return noContent();
    },
  }),

  route({
    tags: ['acesso'],
    auth: 'session',
    permission: 'users.manage',
    method: 'GET',
    url: '/roles',
    summary: 'Listar papéis da empresa',
    handler: async ({ db, tenantId }) => {
      const result = await db.query<RoleRow>(
        `${ROLE_SELECT} WHERE r.tenant_id = $1 ORDER BY r.is_system DESC, lower(r.name), r.id`,
        [tenantId],
      );
      return { items: result.rows.map(roleView) };
    },
  }),

  route({
    tags: ['acesso'],
    auth: 'session',
    permission: 'users.manage',
    method: 'POST',
    url: '/roles',
    summary: 'Criar papel',
    body: createRoleBody,
    handler: async ({ db, tenantId, auth, body, audit }) => {
      const permissions = sanitizePermissions(body.permissions);
      assertWithinActor(auth, permissions, GRANT_MESSAGE);
      let id: string;
      try {
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO roles (tenant_id, key, name, description, is_system, permissions)
           VALUES ($1, $2, $3, $4, false, $5) RETURNING id`,
          [tenantId, body.key, body.name, body.description ?? '', permissions],
        );
        id = inserted.rows[0]!.id;
      } catch (error) {
        if (isUniqueViolation(error, 'roles_tenant_id_key_key')) {
          throw conflict('Já existe um papel com esta chave.', 'role_key_taken');
        }
        throw error;
      }
      await audit({
        action: 'role.created',
        entityType: 'role',
        entityId: id,
        summary: `Papel ${body.name} criado`,
        after: { key: body.key, name: body.name, description: body.description ?? '', permissions },
      });
      return created(roleView((await findRole(db, tenantId, id))!));
    },
  }),

  route({
    tags: ['acesso'],
    auth: 'session',
    permission: 'users.manage',
    method: 'PATCH',
    url: '/roles/:id',
    summary: 'Alterar papel',
    params: idParams,
    body: updateRoleBody,
    handler: async ({ db, tenantId, auth, params, body, audit }) => {
      await lockTenantAccess(db, tenantId);
      const before = await findRole(db, tenantId, params.id);
      if (!before) throw notFound('Papel não encontrado.');
      if (before.is_system) throw forbidden('Papéis do sistema não podem ser alterados.', 'system_role');
      assertWithinActor(auth, before.permissions, TARGET_MESSAGE);
      const permissions = body.permissions ? sanitizePermissions(body.permissions) : before.permissions;
      assertWithinActor(auth, permissions, GRANT_MESSAGE);
      await db.query(
        `UPDATE roles SET name = $3, description = $4, permissions = $5 WHERE tenant_id = $1 AND id = $2`,
        [tenantId, params.id, body.name ?? before.name, body.description ?? before.description, permissions],
      );
      await assertAdminRemains(db, tenantId);
      if (body.permissions) await markAccessChanged(db, tenantId, { roleId: params.id }, auth.userId);
      const after = (await findRole(db, tenantId, params.id))!;
      await audit({
        action: 'role.updated',
        entityType: 'role',
        entityId: params.id,
        summary: `Papel ${after.name} alterado`,
        before: { name: before.name, description: before.description, permissions: before.permissions },
        after: { name: after.name, description: after.description, permissions: after.permissions },
      });
      return roleView(after);
    },
  }),

  route({
    tags: ['acesso'],
    auth: 'session',
    permission: 'users.manage',
    method: 'DELETE',
    url: '/roles/:id',
    summary: 'Excluir papel sem usuários',
    params: idParams,
    handler: async ({ db, tenantId, auth, params, audit }) => {
      await lockTenantAccess(db, tenantId);
      const role = await findRole(db, tenantId, params.id);
      if (!role) throw notFound('Papel não encontrado.');
      if (role.is_system) throw forbidden('Papéis do sistema não podem ser excluídos.', 'system_role');
      assertWithinActor(auth, role.permissions, TARGET_MESSAGE);
      if (role.user_count > 0) {
        throw conflict('O papel está atribuído a usuários e não pode ser excluído.', 'role_in_use', {
          userCount: role.user_count,
        });
      }
      await db.query('DELETE FROM roles WHERE tenant_id = $1 AND id = $2', [tenantId, params.id]);
      await audit({
        action: 'role.deleted',
        entityType: 'role',
        entityId: params.id,
        summary: `Papel ${role.name} excluído`,
        before: { key: role.key, name: role.name, description: role.description, permissions: role.permissions },
      });
      return noContent();
    },
  }),
];
