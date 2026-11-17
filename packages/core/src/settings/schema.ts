import { z } from 'zod';
import { reconRulesSchema } from '../matching/rules';

/**
 * Configurações de uma empresa. Todo campo tem valor padrão: um documento antigo, sem chaves criadas
 * em versões posteriores, continua válido e recebe os padrões ao ser lido.
 */

const MAX_LOGO_CHARS = 280_000; // cerca de 200 KB em base64

const brandingSchema = z.object({
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB')
    .default('#0b5cab'),
  /** Imagem embutida. SVG não é aceito, por poder conter código. */
  logoDataUrl: z
    .string()
    .max(MAX_LOGO_CHARS, 'O logotipo deve ter no máximo 200 KB')
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Use uma imagem PNG, JPEG ou WebP')
    .nullable()
    .default(null),
});

const approvalsSchema = z.object({
  /** Só tem efeito com o módulo "approvals" ativo para a empresa. */
  enabled: z.boolean().default(false),
  /** Quem propõe não pode aprovar a própria proposta. */
  fourEyes: z.boolean().default(true),
  requireFor: z
    .object({
      manual: z.boolean().default(true),
      divergent: z.boolean().default(true),
      ambiguous: z.boolean().default(false),
      grouped: z.boolean().default(false),
      classification: z.boolean().default(false),
      ignore: z.boolean().default(true),
    })
    .default({ manual: true, divergent: true, ambiguous: false, grouped: false, classification: false, ignore: true }),
});

const importsSchema = z.object({
  /** Dias para manter o arquivo original. Nulo mantém indefinidamente. */
  originalFileRetentionDays: z.number().int().min(30).max(3650).nullable().default(null),
});

const securitySchema = z.object({
  sessionIdleMinutes: z.number().int().min(5).max(1440).default(60),
  passwordMinLength: z.number().int().min(8).max(64).default(10),
});

export const tenantSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  branding: brandingSchema.prefault({}),
  reconciliation: reconRulesSchema.prefault({}),
  approvals: approvalsSchema.prefault({}),
  imports: importsSchema.prefault({}),
  security: securitySchema.prefault({}),
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
export type ApprovalSettings = TenantSettings['approvals'];

/** Entrada parcial aceita na gravação: qualquer subconjunto das chaves. */
export const tenantSettingsPatchSchema = z.object({
  branding: brandingSchema.partial().optional(),
  reconciliation: z.record(z.string(), z.unknown()).optional(),
  approvals: z.record(z.string(), z.unknown()).optional(),
  imports: importsSchema.partial().optional(),
  security: securitySchema.partial().optional(),
});
export type TenantSettingsPatch = z.infer<typeof tenantSettingsPatchSchema>;

export function parseTenantSettings(raw: unknown): TenantSettings {
  return tenantSettingsSchema.parse(raw ?? {});
}

export const DEFAULT_TENANT_SETTINGS: TenantSettings = parseTenantSettings({});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = deepMerge(base[key], value);
  }
  return result;
}

/** Aplica alteração parcial sobre a configuração atual e valida o resultado inteiro. */
export function mergeTenantSettings(current: TenantSettings, patch: TenantSettingsPatch): TenantSettings {
  return tenantSettingsSchema.parse(deepMerge(current, patch));
}

export interface ApprovalQuestion {
  operation: 'suggestion' | 'manual' | 'classification' | 'ignore';
  hasDifference: boolean;
  ambiguous: boolean;
  grouped?: boolean;
}

/** Indica se a decisão precisa de uma segunda pessoa, segundo as regras da empresa. */
export function approvalRequired(approvals: ApprovalSettings, question: ApprovalQuestion): boolean {
  if (!approvals.enabled) return false;
  const rules = approvals.requireFor;
  if (question.operation === 'manual' && rules.manual) return true;
  if (question.operation === 'ignore' && rules.ignore) return true;
  if (question.operation === 'classification' && rules.classification) return true;
  if (question.hasDifference && rules.divergent) return true;
  if (question.ambiguous && rules.ambiguous) return true;
  if (question.grouped && rules.grouped) return true;
  return false;
}
