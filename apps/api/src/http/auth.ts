import type { FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps';
import { API_TOKEN_PREFIX, sha256 } from '../security/tokens';
import { AppError, unauthenticated } from './errors';

export interface AuthContext {
  kind: 'session' | 'api_token';
  sessionId: string | null;
  userId: string | null;
  tenantId: string | null;
  tenantStatus: string | null;
  isPlatformAdmin: boolean;
  name: string;
  email: string | null;
  roleKey: string | null;
  roleName: string | null;
  permissions: string[];
  mustChangePassword: boolean;
  /** A marca de última atividade está defasada e deve ser atualizada nesta requisição. */
  sessionTouchDue: boolean;
  apiTokenId?: string;
  scopes?: string[];
}

interface SessionRow {
  session_id: string;
  user_id: string;
  tenant_id: string | null;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  user_status: string;
  is_platform_admin: boolean;
  must_change_password: boolean;
  name: string;
  email: string;
  tenant_status: string | null;
  role_key: string | null;
  role_name: string | null;
  permissions: string[];
  idle_minutes: number;
}

const SESSION_COOKIE = 'concilia_sid';
const TOUCH_INTERVAL_MS = 60_000;

export async function authenticateSession(deps: AppDeps, req: FastifyRequest): Promise<AuthContext> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw unauthenticated();

  const result = await deps.pool.query<SessionRow>('SELECT * FROM auth_find_session($1)', [sha256(token)]);
  const row = result.rows[0];
  if (!row || row.revoked_at) throw unauthenticated();

  const now = Date.now();
  if (row.expires_at.getTime() <= now || now - row.last_seen_at.getTime() > row.idle_minutes * 60_000) {
    throw new AppError(401, 'session_expired', 'Sua sessão expirou. Entre novamente.');
  }
  if (row.user_status !== 'active') throw unauthenticated();
  if (row.tenant_id !== null && row.tenant_status === 'archived') throw unauthenticated();

  return {
    kind: 'session',
    sessionId: row.session_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    tenantStatus: row.tenant_status,
    isPlatformAdmin: row.is_platform_admin,
    name: row.name,
    email: row.email,
    roleKey: row.role_key,
    roleName: row.role_name,
    permissions: row.permissions ?? [],
    mustChangePassword: row.must_change_password,
    sessionTouchDue: now - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS,
  };
}

interface TokenRow {
  id: string;
  tenant_id: string;
  name: string;
  scopes: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
  tenant_status: string;
}

export async function authenticateApiToken(deps: AppDeps, req: FastifyRequest): Promise<AuthContext> {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith(API_TOKEN_PREFIX)) {
    throw unauthenticated('Token de API ausente ou inválido.', 'invalid_token');
  }
  const result = await deps.pool.query<TokenRow>('SELECT * FROM api_token_find($1)', [sha256(token)]);
  const row = result.rows[0];
  if (!row || row.revoked_at || (row.expires_at && row.expires_at.getTime() <= Date.now())) {
    throw unauthenticated('Token de API ausente ou inválido.', 'invalid_token');
  }
  if (row.tenant_status === 'archived') throw unauthenticated('Token de API ausente ou inválido.', 'invalid_token');
  return {
    kind: 'api_token',
    sessionId: null,
    userId: null,
    tenantId: row.tenant_id,
    tenantStatus: row.tenant_status,
    isPlatformAdmin: false,
    name: `Token de API: ${row.name}`,
    email: null,
    roleKey: null,
    roleName: null,
    permissions: [],
    mustChangePassword: false,
    sessionTouchDue: false,
    apiTokenId: row.id,
    scopes: row.scopes ?? [],
  };
}
