import { integrationConfigSchemas, type WebhookPayloadV1 } from '@concilia/core';
import type { Db } from '../../db/context';
import type { JobHandler, StepsJobContext } from '../../jobs/types';
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

async function attempt(context: StepsJobContext, delivery: DeliveryRow, integration: IntegrationRow): Promise<DeliveryResult> {
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
async function deliver(context: StepsJobContext): Promise<unknown> {
  const { job, tenantId, transaction } = context;
  const deliveryId = typeof job.payload.deliveryId === 'string' ? job.payload.deliveryId : null;
  if (!deliveryId) throw new Error('Trabalho de entrega sem registro de entrega');
  const target = await transaction(async ({ db }) => {
    const found = await db.query<DeliveryRow>('SELECT * FROM notification_deliveries WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      deliveryId,
    ]);
    const delivery = found.rows[0];
    if (!delivery || delivery.status === 'sent' || delivery.status === 'skipped') return null;
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
      return null;
    }
    return { delivery, integration };
  });
  if (!target) return { deliveryId, skipped: true };

  // Envio sem transação aberta; o resultado é gravado em seguida, em transação curta.
  const result = await attempt(context, target.delivery, target.integration);
  await transaction(({ db }) => record(db, target.delivery, result));
  if (result.ok) return { deliveryId, status: 'sent', responseStatus: result.status };
  throw new Error(result.error ?? 'Falha na entrega');
}

export const notificationDeliverHandler: JobHandler = { transaction: 'steps', run: deliver };
