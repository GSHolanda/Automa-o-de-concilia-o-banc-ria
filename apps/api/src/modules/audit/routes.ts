import { z } from 'zod';
import type { Db } from '../../db/context';
import { route, type RouteDefinition } from '../../http/route';

const dateOrDateTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const auditQuery = z.object({
  action: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().max(200).optional(),
  actorId: z.uuid().optional(),
  from: dateOrDateTime.optional(),
  to: dateOrDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Sequência do último item da página anterior. */
  cursor: z.coerce.number().int().min(1).optional(),
});
export type AuditQuery = z.infer<typeof auditQuery>;

interface AuditRow {
  seq: string;
  occurred_at: Date;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
  request_id: string | null;
  ip: string | null;
  hash: string;
}

/** Lista a trilha de uma empresa (ou da plataforma, com `tenantId` nulo), das mais recentes para as mais antigas. */
export async function listAudit(
  db: Db,
  tenantId: string | null,
  query: AuditQuery,
): Promise<{ items: unknown[]; nextCursor?: string }> {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };
  if (tenantId === null) where.push('tenant_id IS NULL');
  else add('tenant_id = ?', tenantId);
  if (query.action) add('action = ?', query.action);
  if (query.entityType) add('entity_type = ?', query.entityType);
  if (query.entityId) add('entity_id = ?', query.entityId);
  if (query.actorId) add('actor_id = ?', query.actorId);
  if (query.from) add(query.from.length === 10 ? 'occurred_at >= ?::date' : 'occurred_at >= ?::timestamptz', query.from);
  // Data sem hora inclui o dia inteiro.
  if (query.to) add(query.to.length === 10 ? 'occurred_at < ?::date + 1' : 'occurred_at <= ?::timestamptz', query.to);
  if (query.cursor) add('seq < ?', query.cursor);
  values.push(query.limit + 1);

  const result = await db.query<AuditRow>(
    `SELECT seq, occurred_at, actor_type, actor_id, actor_label, action, entity_type, entity_id, summary,
            before, after, metadata, request_id, ip, encode(hash, 'hex') AS hash
       FROM audit_log
      WHERE ${where.join(' AND ')}
      ORDER BY seq DESC
      LIMIT $${values.length}`,
    values,
  );
  const rows = result.rows.slice(0, query.limit);
  const items = rows.map((row) => ({
    seq: Number(row.seq),
    occurredAt: row.occurred_at.toISOString(),
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    before: row.before,
    after: row.after,
    metadata: row.metadata,
    requestId: row.request_id,
    ip: row.ip,
    hash: row.hash,
  }));
  const last = rows.at(-1);
  return result.rows.length > query.limit && last ? { items, nextCursor: String(last.seq) } : { items };
}

export interface ChainCheck {
  intact: boolean;
  checked: number;
  brokenSeq: number | null;
  headSeq: number | null;
  headHash: string | null;
}

/** Recalcula a cadeia de hashes visível no contexto atual. */
export async function verifyAuditChain(db: Db, tenantId: string | null): Promise<ChainCheck> {
  const result = await db.query<{
    checked: string;
    broken_seq: string | null;
    head_seq: string | null;
    head_hash: string | null;
  }>('SELECT * FROM audit_verify_chain($1)', [tenantId]);
  const row = result.rows[0];
  const toNumber = (value: string | null | undefined) => (value === null || value === undefined ? null : Number(value));
  return {
    intact: row?.broken_seq === null || row?.broken_seq === undefined,
    checked: Number(row?.checked ?? 0),
    brokenSeq: toNumber(row?.broken_seq),
    headSeq: toNumber(row?.head_seq),
    headHash: row?.head_hash ?? null,
  };
}

export const routes: RouteDefinition[] = [
  route({
    method: 'GET',
    url: '/audit',
    summary: 'Trilha de auditoria da empresa',
    tags: ['auditoria'],
    auth: 'session',
    permission: 'audit.view',
    query: auditQuery,
    handler: async ({ db, tenantId, query }) => listAudit(db, tenantId, query),
  }),
  route({
    method: 'GET',
    url: '/audit/verify',
    summary: 'Verificar a integridade da cadeia de auditoria',
    tags: ['auditoria'],
    auth: 'session',
    permission: 'audit.view',
    handler: async ({ db, tenantId }) => verifyAuditChain(db, tenantId),
  }),
];
