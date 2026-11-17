import { createHmac } from 'node:crypto';
import type { WebhookConfig, WebhookPayloadV1 } from '@concilia/core';
import { safeFetch, SafeFetchError } from './http';

/** Assinatura: hex de HMAC-SHA256(segredo, `${timestamp}.${corpo}`). */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** Envia o evento assinado. Sucesso só com resposta 2xx; redirecionamento não é seguido. */
export async function sendWebhook(
  config: WebhookConfig,
  secret: string,
  payload: WebhookPayloadV1,
  options: { allowPrivate: boolean; timeoutMs?: number },
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    const response = await safeFetch(
      config.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Concilia-Webhook/1',
          'x-concilia-event': payload.event,
          'x-concilia-delivery': payload.id,
          'x-concilia-timestamp': timestamp,
          'x-concilia-signature': `sha256=${signWebhook(secret, timestamp, body)}`,
        },
        body,
      },
      { allowPrivate: options.allowPrivate, timeoutMs: options.timeoutMs, maxBytes: 64 * 1024 },
    );
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status, error: null };
    return { ok: false, status: response.status, error: `O destino respondeu HTTP ${response.status}.` };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof SafeFetchError ? error.message : 'Falha ao enviar o webhook.' };
  }
}
