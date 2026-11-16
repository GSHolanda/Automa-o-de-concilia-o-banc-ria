import { z } from 'zod';
import type { ModuleKey } from '../../modules';
import { connectorFieldMapSchema } from './ledger';

export const INTEGRATION_KINDS = ['webhook', 'smtp', 'rest_ledger', 'ai_provider'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** Módulo que precisa estar ativo para usar cada tipo de integração. */
export const INTEGRATION_MODULES: Readonly<Record<IntegrationKind, ModuleKey>> = {
  webhook: 'notifications.webhook',
  smtp: 'notifications.email',
  rest_ledger: 'connector.rest',
  ai_provider: 'ai.assist',
};

export const INTEGRATION_STATUSES = ['not_configured', 'configured', 'verified', 'error'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

const httpUrl = z
  .string()
  .trim()
  .max(2_000)
  .url('Endereço inválido')
  .refine((value) => /^https?:\/\//i.test(value), 'Use um endereço http(s)');

export const webhookConfigSchema = z.object({ url: httpUrl }).strict();

export const smtpConfigSchema = z
  .object({
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65_535).default(587),
    secure: z.boolean().default(false),
    user: z.string().trim().max(255).nullish().transform((value) => value || null),
    from: z.string().trim().email('Remetente inválido').max(255),
  })
  .strict();

export const REST_AUTH_TYPES = ['none', 'bearer', 'header', 'basic'] as const;

export const restLedgerConfigSchema = z
  .object({
    baseUrl: httpUrl,
    path: z.string().trim().max(500).default('/'),
    authType: z.enum(REST_AUTH_TYPES).default('bearer'),
    /** Nome do cabeçalho quando `authType = header`. Para `basic`, o usuário. */
    headerName: z.string().trim().max(100).nullish().transform((value) => value || null),
    /** Caminho da lista de itens na resposta; nulo quando a resposta já é a lista. */
    itemsPath: z.string().trim().max(200).nullish().transform((value) => value || null),
    /** Nomes dos parâmetros de período na consulta. */
    dateFromParam: z.string().trim().min(1).max(60).default('dateFrom'),
    dateToParam: z.string().trim().min(1).max(60).default('dateTo'),
    amountUnit: z.enum(['decimal', 'cents']).default('decimal'),
    fieldMap: connectorFieldMapSchema,
    bankAccountId: z.uuid().nullish().transform((value) => value ?? null),
  })
  .strict()
  .refine((value) => value.authType !== 'header' || !!value.headerName, {
    message: 'Informe o nome do cabeçalho de autenticação',
    path: ['headerName'],
  })
  .refine((value) => value.authType !== 'basic' || !!value.headerName, {
    message: 'Informe o usuário da autenticação básica em headerName',
    path: ['headerName'],
  });

/** Modelo padrão sugerido; a empresa pode escolher outro na configuração. */
export const DEFAULT_AI_MODEL = 'claude-haiku-5-5';

export const aiProviderConfigSchema = z
  .object({
    provider: z.enum(['anthropic']),
    model: z.string().trim().min(1).max(100).default(DEFAULT_AI_MODEL),
    /** Endereço alternativo da API (ex.: servidor local de teste). */
    baseURL: httpUrl.nullish().transform((value) => value ?? null),
  })
  .strict();

export const integrationConfigSchemas = {
  webhook: webhookConfigSchema,
  smtp: smtpConfigSchema,
  rest_ledger: restLedgerConfigSchema,
  ai_provider: aiProviderConfigSchema,
} as const;

export type WebhookConfig = z.output<typeof webhookConfigSchema>;
export type SmtpConfig = z.output<typeof smtpConfigSchema>;
export type RestLedgerConfig = z.output<typeof restLedgerConfigSchema>;
export type AiProviderConfig = z.output<typeof aiProviderConfigSchema>;

/** O tipo exige segredo para funcionar (assinatura, chave de API, credencial). */
export function integrationNeedsSecret(kind: IntegrationKind, config: unknown): boolean {
  if (kind === 'webhook' || kind === 'ai_provider') return true;
  if (kind === 'rest_ledger') return (config as RestLedgerConfig | null)?.authType !== 'none';
  return !!(config as SmtpConfig | null)?.user;
}
