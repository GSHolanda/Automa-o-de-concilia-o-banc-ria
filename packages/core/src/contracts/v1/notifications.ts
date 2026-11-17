import { z } from 'zod';

/** Eventos que podem gerar aviso interno, webhook ou e-mail. */
export const NOTIFICATION_EVENTS = [
  'import.completed',
  'import.failed',
  'reconciliation.completed',
  'approval.requested',
  'job.dead',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_EVENT_LABELS: Readonly<Record<NotificationEvent, string>> = {
  'import.completed': 'Importação concluída',
  'import.failed': 'Importação com falha',
  'reconciliation.completed': 'Conciliação concluída',
  'approval.requested': 'Aprovação solicitada',
  'job.dead': 'Trabalho em falha definitiva',
};

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'webhook'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const inAppTargetSchema = z
  .object({ roleKeys: z.array(z.string().trim().min(1).max(60)).min(1).max(20) })
  .strict();
export const emailTargetSchema = z
  .object({ emails: z.array(z.string().trim().email('E-mail inválido')).min(1).max(20) })
  .strict();

/** Corpo assinado de um webhook: `X-Concilia-Signature: sha256=HMAC(segredo, timestamp + "." + corpo)`. */
export interface WebhookPayloadV1 {
  id: string;
  event: NotificationEvent | 'integration.test';
  occurredAt: string;
  data: Record<string, unknown>;
}
