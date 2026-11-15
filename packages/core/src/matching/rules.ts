import { z } from 'zod';

/**
 * Regras de conciliação configuráveis por empresa.
 * A conciliação automática depende apenas destas regras; a pontuação de confiança nunca decide.
 */
export const reconRulesSchema = z.object({
  /** Diferença máxima de dias entre extrato e lançamento nas regras de valor e data. */
  dateToleranceDays: z.number().int().min(0).max(30).default(2),
  /** Diferença máxima de dias quando identificador e valor conferem. */
  identifierMaxDateDiffDays: z.number().int().min(0).max(120).default(10),
  /** Diferença de valor aceita para sugerir correspondência (nunca concilia sozinho). */
  amountToleranceCents: z.number().int().min(0).max(1_000_000).default(0),
  amountTolerancePercent: z.number().min(0).max(10).default(0),
  /** Identificadores mais curtos que isto são ignorados na regra de identificador. */
  minIdentifierLength: z.number().int().min(3).max(20).default(4),
  autoConfirm: z
    .object({
      byIdentifier: z.boolean().default(true),
      byAmountDateReference: z.boolean().default(true),
      byUniqueAmountDate: z.boolean().default(true),
      internalTransfers: z.boolean().default(false),
      fees: z.boolean().default(false),
    })
    .default({
      byIdentifier: true,
      byAmountDateReference: true,
      byUniqueAmountDate: true,
      internalTransfers: false,
      fees: false,
    }),
  suggestions: z
    .object({
      minConfidence: z.number().min(0).max(1).default(0.3),
      maxPerItem: z.number().int().min(1).max(10).default(3),
    })
    .default({ minConfidence: 0.3, maxPerItem: 3 }),
  grouping: z
    .object({
      enabled: z.boolean().default(true),
      maxGroupSize: z.number().int().min(2).max(6).default(4),
      maxCandidates: z.number().int().min(2).max(16).default(12),
    })
    .default({ enabled: true, maxGroupSize: 4, maxCandidates: 12 }),
  transfers: z
    .object({
      enabled: z.boolean().default(true),
      dateToleranceDays: z.number().int().min(0).max(10).default(1),
    })
    .default({ enabled: true, dateToleranceDays: 1 }),
  reversals: z
    .object({
      enabled: z.boolean().default(true),
      windowDays: z.number().int().min(0).max(180).default(30),
    })
    .default({ enabled: true, windowDays: 30 }),
});

export type ReconRules = z.infer<typeof reconRulesSchema>;

export const DEFAULT_RECON_RULES: ReconRules = reconRulesSchema.parse({});
