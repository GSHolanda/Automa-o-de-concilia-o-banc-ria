import { z } from 'zod';
import { parseAmount } from '../../money';
import { parseDate } from '../../dates';

/** Data civil AAAA-MM-DD existente. */
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use data no formato AAAA-MM-DD')
  .refine((value) => {
    try {
      return parseDate(value, { format: 'YYYY-MM-DD' }) === value;
    } catch {
      return false;
    }
  }, 'Data inexistente');

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((value) => value || null);

/**
 * Lançamento do sistema financeiro recebido por API ou conector (contrato v1).
 * Dinheiro em centavos inteiros: entrada positiva, saída negativa.
 */
export const ledgerEntryInputV1Schema = z.object({
  externalId: optionalText(120),
  date: civilDate,
  amountCents: z
    .number({ message: 'Valor ausente ou inválido (centavos inteiros)' })
    .int('O valor deve estar em centavos inteiros')
    .refine((value) => value !== 0, 'O valor não pode ser zero')
    .refine((value) => Number.isSafeInteger(value), 'Valor fora do intervalo suportado'),
  description: z.string({ message: 'Descrição ausente' }).trim().min(1, 'Descrição ausente').max(500),
  document: optionalText(120),
  reference: optionalText(120),
  counterparty: optionalText(200),
  dueDate: civilDate.nullish().transform((value) => value ?? null),
  bankAccountRef: optionalText(120),
  costCenter: optionalText(120),
  category: optionalText(120),
});

export type LedgerEntryInputV1 = z.output<typeof ledgerEntryInputV1Schema>;
export type LedgerEntryInputV1Input = z.input<typeof ledgerEntryInputV1Schema>;

/** Máximo de lançamentos por chamada da API de entrada. */
export const LEDGER_API_MAX_ENTRIES = 1_000;

/** Escopos possíveis de um token de API. */
export const API_TOKEN_SCOPES = ['ledger:write'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** Campos do lançamento e o caminho (com pontos) onde cada um está no item devolvido pela API externa. */
export const connectorFieldMapSchema = z.object({
  date: z.string().trim().min(1).max(200),
  amount: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(200),
  externalId: z.string().trim().min(1).max(200).optional(),
  document: z.string().trim().min(1).max(200).optional(),
  reference: z.string().trim().min(1).max(200).optional(),
  counterparty: z.string().trim().min(1).max(200).optional(),
  dueDate: z.string().trim().min(1).max(200).optional(),
  bankAccountRef: z.string().trim().min(1).max(200).optional(),
  costCenter: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(200).optional(),
});
export type ConnectorFieldMap = z.infer<typeof connectorFieldMapSchema>;

/** Lê um caminho como `a.b.0.c`. Caminho vazio devolve o próprio valor. */
export function readPath(value: unknown, path: string | null | undefined): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function dateOf(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  try {
    return parseDate(typeof value === 'number' ? String(value) : value);
  } catch {
    return undefined;
  }
}

function centsOf(value: unknown, unit: 'decimal' | 'cents'): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  try {
    if (unit === 'cents') {
      const number = typeof value === 'number' ? value : Number(value.trim());
      return Number.isSafeInteger(number) ? number : undefined;
    }
    return parseAmount(value, { decimalSeparator: typeof value === 'string' && value.includes(',') ? 'auto' : '.' });
  } catch {
    return undefined;
  }
}

/**
 * Converte um item da API externa em lançamento v1 pelo mapa de campos. Campos ilegíveis ficam
 * ausentes: a validação com `ledgerEntryInputV1Schema` aponta o motivo da rejeição.
 */
export function mapConnectorItem(
  item: unknown,
  fieldMap: ConnectorFieldMap,
  options: { amountUnit?: 'decimal' | 'cents' } = {},
): Record<string, unknown> {
  const pick = (key: keyof ConnectorFieldMap) => readPath(item, fieldMap[key]);
  const entry: Record<string, unknown> = {
    date: dateOf(pick('date')),
    amountCents: centsOf(pick('amount'), options.amountUnit ?? 'decimal'),
    description: text(pick('description')),
  };
  const optional = ['externalId', 'document', 'reference', 'counterparty', 'bankAccountRef', 'costCenter', 'category'] as const;
  for (const key of optional) {
    if (fieldMap[key]) entry[key] = text(pick(key)) ?? null;
  }
  if (fieldMap.dueDate) entry.dueDate = dateOf(pick('dueDate')) ?? null;
  return entry;
}

/** Conector de leitura de lançamentos do sistema financeiro (contrato v1). */
export interface LedgerConnectorV1 {
  readonly version: 'v1';
  /** Chamada real de verificação. Lança erro se o serviço não responder como esperado. */
  test(): Promise<void>;
  /** Lançamentos do período, já no formato v1 (itens ilegíveis seguem para rejeição na importação). */
  pull(range: { dateFrom: string; dateTo: string }): Promise<{ items: Record<string, unknown>[]; raw: unknown[] }>;
}
