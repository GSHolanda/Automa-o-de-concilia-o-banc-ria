import type { NotificationEvent, PermissionKey, WebhookPayloadV1 } from '@concilia/core';
import type { Db } from '../../db/context';
import { enqueue } from '../../jobs/queue';
import { loadEntitlements } from '../tenancy/entitlements';

export const DELIVER_JOB_TYPE = 'notification.deliver';

export interface NotificationInput {
  tenantId: string;
  event: NotificationEvent;
  title: string;
  body: string;
  link?: string | null;
  /** Dados do evento enviados por webhook. Sem segredos nem dados pessoais além do necessário. */
  data: Record<string, unknown>;
  /** Aviso interno padrão do evento: quem tem a permissão recebe (menos quem for excluído). */
  defaultRecipients?: { permission: PermissionKey; excludeUserId?: string | null };
  /** Só avisos internos: evita que a falha definitiva de uma entrega gere nova entrega. */
  internalOnly?: boolean;
}

interface RuleRow {
  id: string;
  channel: 'in_app' | 'email' | 'webhook';
  target: { roleKeys?: string[]; emails?: string[] };
  integration_id: string | null;
  integration_kind: string | null;
  integration_active: boolean | null;
}

const CHANNEL_MODULE = { webhook: 'notifications.webhook', email: 'notifications.email' } as const;
const CHANNEL_KIND = { webhook: 'webhook', email: 'smtp' } as const;

/**
 * Ponto único de emissão de eventos de notificação, na transação da operação que os originou:
 * avisos internos (padrão do evento + regras `in_app`) e entregas externas (regras `webhook`/`email`),
 * cada uma registrada em `notification_deliveries` e enviada pelo trabalho `notification.deliver`.
 */
export async function emitNotification(db: Db, input: NotificationInput): Promise<void> {
  const rules = await db.query<RuleRow>(
    `SELECT r.id, r.channel, r.target, r.integration_id, i.kind AS integration_kind, i.active AS integration_active
       FROM notification_rules r
       LEFT JOIN integrations i ON i.tenant_id = r.tenant_id AND i.id = r.integration_id
      WHERE r.tenant_id = $1 AND r.event = $2 AND r.active
      ORDER BY r.created_at, r.id`,
    [input.tenantId, input.event],
  );

  const roleKeys = [...new Set(rules.rows.filter((rule) => rule.channel === 'in_app').flatMap((rule) => rule.target.roleKeys ?? []))];
  const permission = input.defaultRecipients?.permission ?? null;
  if (permission || roleKeys.length > 0) {
    // Cada pessoa recebe um aviso, mesmo que entre por mais de um critério.
    await db.query(
      `INSERT INTO notifications (tenant_id, user_id, event, title, body, link)
       SELECT DISTINCT u.tenant_id, u.id, $2::text, $3::text, $4::text, $5::text
         FROM users u
         JOIN roles r ON r.tenant_id = u.tenant_id AND r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.status = 'active'
          AND (($6::text IS NOT NULL AND $6::text = ANY (r.permissions)) OR r.key = ANY ($7::text[]))
          AND ($8::uuid IS NULL OR u.id <> $8::uuid)`,
      [
        input.tenantId,
        input.event,
        input.title,
        input.body,
        input.link ?? null,
        permission,
        roleKeys,
        input.defaultRecipients?.excludeUserId ?? null,
      ],
    );
  }

  if (input.internalOnly) return;
  const external = rules.rows.filter((rule) => rule.channel !== 'in_app');
  if (external.length === 0) return;
  const modules = (await loadEntitlements(db, input.tenantId)).modules as string[];
  const occurredAt = new Date().toISOString();

  for (const rule of external) {
    const channel = rule.channel as 'webhook' | 'email';
    let skipped: string | null = null;
    if (!modules.includes(CHANNEL_MODULE[channel])) skipped = 'Módulo de notificação desabilitado.';
    else if (!rule.integration_id || rule.integration_kind !== CHANNEL_KIND[channel]) skipped = 'Integração da regra inexistente.';
    else if (!rule.integration_active) skipped = 'Integração da regra inativa.';

    const created = await db.query<{ id: string }>(
      `INSERT INTO notification_deliveries (tenant_id, rule_id, integration_id, channel, event, status, error, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{}') RETURNING id`,
      [input.tenantId, rule.id, rule.integration_id, channel, input.event, skipped ? 'skipped' : 'pending', skipped],
    );
    const deliveryId = created.rows[0]!.id;
    const payload =
      channel === 'webhook'
        ? ({ id: deliveryId, event: input.event, occurredAt, data: input.data } satisfies WebhookPayloadV1)
        : { to: rule.target.emails ?? [], subject: input.title, text: `${input.body}${input.link ? `\n\n${input.link}` : ''}` };
    await db.query('UPDATE notification_deliveries SET payload = $3 WHERE tenant_id = $1 AND id = $2', [
      input.tenantId,
      deliveryId,
      JSON.stringify(payload),
    ]);
    if (!skipped) {
      await enqueue(db, {
        tenantId: input.tenantId,
        type: DELIVER_JOB_TYPE,
        payload: { deliveryId },
        idempotencyKey: deliveryId,
      });
    }
  }
}
