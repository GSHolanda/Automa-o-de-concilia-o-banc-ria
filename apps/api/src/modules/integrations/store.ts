import {
  INTEGRATION_MODULES,
  integrationConfigSchemas,
  integrationNeedsSecret,
  maskUrl,
  type AiProviderConfig,
  type IntegrationKind,
  type IntegrationStatus,
  type RestLedgerConfig,
  type SmtpConfig,
  type WebhookConfig,
} from '@concilia/core';
import { randomUUID } from 'node:crypto';
import type { Config } from '../../config/env';
import type { Db } from '../../db/context';
import { AppError, notFound } from '../../http/errors';
import { createAnthropicProvider } from '../../integrations/anthropic';
import { createRestLedgerConnector } from '../../integrations/rest-ledger';
import { verifySmtp } from '../../integrations/smtp';
import { sendWebhook } from '../../integrations/webhook';
import { decryptWithMasterKeys, encryptSecret, scrubSecret } from '../../security/secrets';
import type { Entitlements } from '../tenancy/entitlements';

export type SecretConfig = Pick<
  Config,
  'secretsMasterKey' | 'secretsKeyVersion' | 'secretsPreviousKey' | 'allowPrivateIntegrationHosts'
>;

export interface IntegrationRow {
  id: string;
  tenant_id: string;
  kind: IntegrationKind;
  name: string;
  config: Record<string, unknown>;
  secret_ciphertext: Buffer | null;
  secret_key_version: number | null;
  status: IntegrationStatus;
  last_checked_at: Date | null;
  last_error: string | null;
  active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Visão pública: o segredo nunca sai; apenas se está configurado. */
export function integrationView(row: IntegrationRow, modules?: readonly string[]) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: row.config,
    hasSecret: row.secret_ciphertext !== null,
    status: row.status,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    lastError: row.last_error,
    active: row.active,
    ...(modules ? { moduleEnabled: modules.includes(INTEGRATION_MODULES[row.kind]) } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Campos de endereço: caminho e consulta podem ser a própria credencial (token de webhook). */
const URL_FIELDS = ['url', 'baseUrl', 'baseURL'] as const;

/** Visão para a trilha de auditoria: endereços reduzidos a esquema, host e porta. */
export function integrationAuditView(row: IntegrationRow, modules?: readonly string[]) {
  const view = integrationView(row, modules);
  const config: Record<string, unknown> = { ...view.config };
  for (const field of URL_FIELDS) {
    if (typeof config[field] === 'string') config[field] = maskUrl(config[field]);
  }
  return { ...view, config };
}

export const ERROR_LIMIT = 1_000;

export async function findIntegration(db: Db, tenantId: string, id: string, forUpdate = false): Promise<IntegrationRow> {
  const result = await db.query<IntegrationRow>(
    `SELECT * FROM integrations WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenantId, id],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Integração não encontrada.');
  return row;
}

export function assertKindModule(entitlements: Entitlements, kind: IntegrationKind): void {
  const module = INTEGRATION_MODULES[kind];
  if (!entitlements.modules.includes(module)) {
    throw new AppError(403, 'module_disabled', 'Este módulo não está habilitado para a empresa.', { module });
  }
}

export function newIntegrationId(): string {
  return randomUUID();
}

export function sealSecret(config: SecretConfig, tenantId: string, integrationId: string, secret: string): Buffer {
  return encryptSecret(config.secretsMasterKey, config.secretsKeyVersion, { tenantId, integrationId }, secret);
}

/** Decifra no contexto da empresa e da integração; texto de outra empresa não decifra. Aceita a chave anterior. */
export function readSecret(config: SecretConfig, row: IntegrationRow): string | null {
  if (!row.secret_ciphertext) return null;
  return decryptWithMasterKeys(
    { current: config.secretsMasterKey, previous: config.secretsPreviousKey },
    { tenantId: row.tenant_id, integrationId: row.id },
    row.secret_ciphertext,
  );
}

/** Situação sem chamada externa: `verified` nunca é atribuída aqui. */
export function initialStatus(kind: IntegrationKind, config: unknown, hasSecret: boolean): IntegrationStatus {
  return integrationNeedsSecret(kind, config) && !hasSecret ? 'not_configured' : 'configured';
}

export class IntegrationCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationCheckError';
  }
}

/** Chamada real ao serviço externo. Lança IntegrationCheckError com mensagem sem segredo. */
export async function checkIntegration(config: SecretConfig, row: IntegrationRow): Promise<void> {
  let secret: string | null = null;
  try {
    secret = readSecret(config, row);
    if (integrationNeedsSecret(row.kind, row.config) && !secret) {
      throw new IntegrationCheckError('Segredo da integração não configurado.');
    }
    const allowPrivate = config.allowPrivateIntegrationHosts;
    switch (row.kind) {
      case 'webhook': {
        const parsed: WebhookConfig = integrationConfigSchemas.webhook.parse(row.config);
        const result = await sendWebhook(
          parsed,
          secret as string,
          { id: randomUUID(), event: 'integration.test', occurredAt: new Date().toISOString(), data: { integrationId: row.id } },
          { allowPrivate },
        );
        if (!result.ok) throw new IntegrationCheckError(result.error ?? 'Falha ao enviar o webhook.');
        return;
      }
      case 'smtp': {
        const parsed: SmtpConfig = integrationConfigSchemas.smtp.parse(row.config);
        await verifySmtp(parsed, secret, allowPrivate);
        return;
      }
      case 'rest_ledger': {
        const parsed: RestLedgerConfig = integrationConfigSchemas.rest_ledger.parse(row.config);
        await createRestLedgerConnector(parsed, secret, { allowPrivate }).test();
        return;
      }
      case 'ai_provider': {
        const parsed: AiProviderConfig = integrationConfigSchemas.ai_provider.parse(row.config);
        await createAnthropicProvider(parsed, secret as string, { allowPrivate }).test();
        return;
      }
    }
  } catch (error) {
    const message = error instanceof Error && error.name !== 'ZodError' ? error.message : 'Configuração inválida.';
    throw new IntegrationCheckError(scrubSecret(message, secret).slice(0, ERROR_LIMIT));
  }
}

/**
 * Grava o resultado de uma chamada real: `verified` só com sucesso; falha vira `error` com mensagem.
 * Só vale para a configuração e o segredo que foram testados: se mudaram durante a chamada, devolve nulo.
 */
export async function recordCheck(db: Db, row: IntegrationRow, error: string | null): Promise<IntegrationRow | null> {
  const result = await db.query<IntegrationRow>(
    `UPDATE integrations SET status = $3, last_error = $4, last_checked_at = now()
      WHERE tenant_id = $1 AND id = $2 AND config = $5::jsonb AND secret_ciphertext IS NOT DISTINCT FROM $6::bytea
      RETURNING *`,
    [row.tenant_id, row.id, error === null ? 'verified' : 'error', error, JSON.stringify(row.config), row.secret_ciphertext],
  );
  return result.rows[0] ?? null;
}
