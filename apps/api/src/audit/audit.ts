import type { Db } from '../db/context';

export interface AuditActor {
  type: 'user' | 'system' | 'api_token' | 'platform';
  id: string | null;
  label: string | null;
}

export interface AuditEntry {
  tenantId: string | null;
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ip?: string | null;
}

const SENSITIVE_KEY = /pass(word)?|senha|secret|segredo|token|hash|ciphertext|authorization|api[_-]?key|cookie/i;

/** Remove valores de chaves sensíveis antes de gravar na trilha. A trilha nunca contém segredos. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 8) return value ?? null;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return '[binário]';
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? '[omitido]' : redact(item, depth + 1);
    }
    return result;
  }
  return value;
}

/**
 * Grava um registro de auditoria na transação corrente: a alteração e a sua evidência
 * são confirmadas juntas ou desfeitas juntas. Sequência e hash são calculados pelo banco.
 */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log
       (tenant_id, actor_type, actor_id, actor_label, action, entity_type, entity_id, summary,
        before, after, metadata, request_id, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      entry.tenantId,
      entry.actor.type,
      entry.actor.id,
      entry.actor.label,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.summary,
      entry.before === undefined ? null : JSON.stringify(redact(entry.before)),
      entry.after === undefined ? null : JSON.stringify(redact(entry.after)),
      JSON.stringify(redact(entry.metadata ?? {})),
      entry.requestId ?? null,
      entry.ip ?? null,
    ],
  );
}
