import { integrationConfigSchemas, type WebhookPayloadV1 } from '@concilia/core';
import { withContext, type Db } from '../../db/context';
import type { JobContext, JobHandler } from '../../jobs/types';
import { sendSmtp } from '../../integrations/smtp';
import { sendWebhook, type DeliveryResult } from '../../integrations/webhook';
import { scrubSecret } from '../../security/secrets';
import { ERROR_LIMIT, readSecret, type IntegrationRow } from '../integrations/store';

interface DeliveryRow {
  id: string;
  tenant_id: string;
  integration_id: string | null;
  channel: 'email' | 'webhook';
  event: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  payload: Record<string, unknown>;
}

async function attempt(context: JobContext, delivery: DeliveryRow, integration: IntegrationRow): Promise<DeliveryResult> {
  const config = context.deps.config;
  let secret: string | null = null;
  try {
    secret = readSecret(config, integration);
    if (delivery.channel === 'webhook') {
      if (!secret) return { ok: false, status: null, error: 'Segredo do webhook não configurado.' };
      const result = await sendWebhook(
        integrationConfigSchemas.webhook.parse(integration.config),
        secret,
        delivery.payload as unknown as WebhookPayloadV1,
        { allowPrivate: config.allowPrivateIntegrationHosts },
      );
      return { ...result, error: result.error ? scrubSecret(result.error, secret) : null };
    }
    const message = delivery.payload as { to?: string[]; subject?: string; text?: string };
    await sendSmtp(integrationConfigSchemas.smtp.parse(integration.config), secret, config.allowPrivateIntegrationHosts, {
      to: message.to ?? [],
      subject: message.subject ?? delivery.event,
      text: message.text ?? '',
    });
    return { ok: true, status: null, error: null };
  } catch (error) {
    const text = error instanceof Error && error.name !== 'ZodError' ? error.message : 'Configuração inválida.';
    return { ok: false, status: null, error: scrubSecret(text, secret) };
  }
}

async function record(db: Db, delivery: DeliveryRow, result: DeliveryResult): Promise<void> {
  await db.query(
    `UPDATE notification_deliveries
        SET status = $3, attempts = attempts + 1, response_status = $4, error = $5,
            sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END
      WHERE tenant_id = $1 AND id = $2`,
    [delivery.tenant_id, delivery.id, result.ok ? 'sent' : 'failed', result.status, result.error?.slice(0, ERROR_LIMIT) ?? null],
  );
}

/**
 * Entrega externa de uma notificação. `sent` só com sucesso real (2xx no webhook); cada falha fica
 * registrada como `failed` com o motivo e o trabalho é repetido com espera até o limite de tentativas.
 */
async function deliver(context: JobContext): Promise<unknown> {
  const { db, job, tenantId } = context;
  const deliveryId = typeof job.payload.deliveryId === 'string' ? job.payload.deliveryId : null;
  if (!deliveryId) throw new Error('Trabalho de entrega sem registro de entrega');
  const found = await db.query<DeliveryRow>('SELECT * FROM notification_deliveries WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    deliveryId,
  ]);
  const delivery = found.rows[0];
  if (!delivery || delivery.status === 'sent' || delivery.status === 'skipped') {
    return { deliveryId, skipped: true };
  }
  const integration = delivery.integration_id
    ? (
        await db.query<IntegrationRow>('SELECT * FROM integrations WHERE tenant_id = $1 AND id = $2', [
          tenantId,
          delivery.integration_id,
        ])
      ).rows[0]
    : undefined;
  if (!integration || !integration.active) {
    await db.query(
      `UPDATE notification_deliveries SET status = 'skipped', error = 'Integração inexistente ou inativa.'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, deliveryId],
    );
    return { deliveryId, skipped: true };
  }

  const result = await attempt(context, delivery, integration);
  if (result.ok) {
    await record(db, delivery, result);
    return { deliveryId, status: 'sent', responseStatus: result.status };
  }
  // A falha é gravada em transação própria: a do trabalho é desfeita ao lançar o erro para nova tentativa.
  await withContext(context.deps.pool, { tenantId }, (own) => record(own, delivery, result));
  throw new Error(result.error ?? 'Falha na entrega');
}

export const notificationDeliverHandler: JobHandler = { run: deliver };
