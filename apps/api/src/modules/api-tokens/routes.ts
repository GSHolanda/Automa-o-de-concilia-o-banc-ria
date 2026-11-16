import { API_TOKEN_SCOPES } from '@concilia/core';
import { z } from 'zod';
import { badRequest, notFound } from '../../http/errors';
import { created, noContent, route, type RouteDefinition } from '../../http/route';
import { generateApiToken, sha256 } from '../../security/tokens';

interface TokenRow {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

/** Visão do token: só o prefixo; o valor completo aparece uma única vez, na criação. */
function tokenView(row: TokenRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    scopes: row.scopes,
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

const COLUMNS = 'id, name, token_prefix, scopes, expires_at, revoked_at, last_used_at, created_by, created_at';

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1).max(API_TOKEN_SCOPES.length).default(['ledger:write']),
  expiresAt: z.iso.datetime({ offset: true }).nullish(),
});

export const routes: RouteDefinition[] = [
  route({
    tags: ['integrações'],
    auth: 'session',
    permission: 'integrations.manage',
    module: 'api.inbound',
    method: 'GET',
    url: '/api-tokens',
    summary: 'Listar tokens de API (só o prefixo)',
    handler: async ({ db, tenantId }) => {
      const result = await db.query<TokenRow>(
        `SELECT ${COLUMNS} FROM api_tokens WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC`,
        [tenantId],
      );
      return { items: result.rows.map(tokenView) };
    },
  }),

  route({
    tags: ['integrações'],
    auth: 'session',
    permission: 'integrations.manage',
    module: 'api.inbound',
    method: 'POST',
    url: '/api-tokens',
    summary: 'Criar token de API (o valor é exibido uma única vez)',
    body: createBody,
    handler: async ({ db, tenantId, auth, body, audit }) => {
      if (body.expiresAt && new Date(body.expiresAt).getTime() <= Date.now()) {
        throw badRequest('A validade do token deve estar no futuro.', 'invalid_expiration');
      }
      const generated = generateApiToken();
      const scopes = [...new Set(body.scopes)];
      const inserted = await db.query<TokenRow>(
        `INSERT INTO api_tokens (tenant_id, name, token_prefix, token_hash, scopes, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
        [tenantId, body.name, generated.prefix, sha256(generated.token), scopes, body.expiresAt ?? null, auth.userId],
      );
      const view = tokenView(inserted.rows[0]!);
      await audit({
        action: 'api_token.created',
        entityType: 'api_token',
        entityId: view.id,
        summary: `Token de API ${view.name} criado (${view.prefix}…)`,
        after: { name: view.name, prefix: view.prefix, scopes: view.scopes, expiresAt: view.expiresAt },
      });
      return created({ ...view, token: generated.token });
    },
  }),

  route({
    tags: ['integrações'],
    auth: 'session',
    permission: 'integrations.manage',
    module: 'api.inbound',
    method: 'POST',
    url: '/api-tokens/:id/revoke',
    summary: 'Revogar token de API (efeito imediato)',
    params: z.object({ id: z.uuid() }),
    handler: async ({ db, tenantId, params, audit }) => {
      const found = await db.query<TokenRow>(`SELECT ${COLUMNS} FROM api_tokens WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
        tenantId,
        params.id,
      ]);
      const row = found.rows[0];
      if (!row) throw notFound('Token de API não encontrado.');
      if (row.revoked_at) return noContent();
      await db.query('UPDATE api_tokens SET revoked_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId, row.id]);
      await audit({
        action: 'api_token.revoked',
        entityType: 'api_token',
        entityId: row.id,
        summary: `Token de API ${row.name} revogado (${row.token_prefix}…)`,
        before: { revokedAt: null },
        after: { revokedAt: new Date().toISOString() },
      });
      return noContent();
    },
  }),
];
