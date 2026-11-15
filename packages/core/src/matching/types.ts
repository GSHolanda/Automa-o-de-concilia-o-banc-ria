import type { ItemKind } from '../classification';
import type { ReconRules } from './rules';

/** Item preparado para o motor: extrato ou lançamento, já normalizado. */
export interface ReconItem {
  id: string;
  side: 'bank' | 'ledger';
  /** Conta bancária a que o item pertence. */
  accountId: string | null;
  date: string;
  amountCents: number;
  descriptionNorm: string;
  /** Identificadores normalizados: documento, referência e os extraídos da descrição. */
  identifiers: string[];
  kind: ItemKind;
  categoryId?: string | null;
}

export const ENGINE_MATCH_TYPES = [
  'identifier',
  'amount_date',
  'tolerance',
  'group',
  'internal_transfer',
  'reversal',
  'classification',
] as const;
export type EngineMatchType = (typeof ENGINE_MATCH_TYPES)[number];

export const RULE_CODES = [
  'ID_VALOR',
  'ID_VALOR_DATA_FORA',
  'ID_VALOR_DIVERGENTE',
  'VALOR_DATA_REFERENCIA',
  'VALOR_DATA_UNICO',
  'VALOR_DATA_AMBIGUO',
  'TOLERANCIA_VALOR',
  'AGRUPAMENTO',
  'TRANSFERENCIA_INTERNA',
  'ESTORNO',
  'CLASSIFICACAO_REGRA',
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

export const RULE_LABELS: Record<RuleCode, string> = {
  ID_VALOR: 'Identificador e valor',
  ID_VALOR_DATA_FORA: 'Identificador e valor, data fora do limite',
  ID_VALOR_DIVERGENTE: 'Identificador igual, valor diferente',
  VALOR_DATA_REFERENCIA: 'Valor, data e descrição',
  VALOR_DATA_UNICO: 'Valor e data, candidato único',
  VALOR_DATA_AMBIGUO: 'Valor e data, vários candidatos',
  TOLERANCIA_VALOR: 'Valor dentro da tolerância',
  AGRUPAMENTO: 'Agrupamento de itens',
  TRANSFERENCIA_INTERNA: 'Transferência entre contas',
  ESTORNO: 'Estorno',
  CLASSIFICACAO_REGRA: 'Classificação por regra',
};

/** Componentes da pontuação, cada um de 0 a 1, e o número de candidatos concorrentes. */
export interface ScoreBreakdown {
  amount: number;
  date: number;
  identifier: number;
  description: number;
  competitors: number;
}

export interface ProposedMatch {
  type: EngineMatchType;
  /** auto: regra determinística satisfeita. suggest: exige decisão humana. */
  decision: 'auto' | 'suggest';
  ruleCode: RuleCode;
  bankIds: string[];
  ledgerIds: string[];
  /** Força da evidência, de 0 a 1. Serve para ordenar e explicar; não decide a conciliação. */
  confidence: number;
  breakdown: ScoreBreakdown;
  /** Soma do extrato menos soma dos lançamentos, em centavos. Zero quando não se aplica. */
  differenceCents: number;
  dateDiffDays: number;
  divergence: 'amount' | 'date' | null;
  ambiguous: boolean;
  categoryId: string | null;
  explanation: string;
}

export interface ReconInput {
  /** Extrato da conta em conciliação. */
  bank: readonly ReconItem[];
  ledger: readonly ReconItem[];
  /** Extratos pendentes de outras contas da empresa, usados só para transferências internas. */
  otherAccountsBank?: readonly ReconItem[];
  /** Pares já rejeitados por pessoas; ver pairKey. */
  rejectedPairs?: ReadonlySet<string>;
  rules: ReconRules;
}

export interface ReconStats {
  bankItems: number;
  ledgerItems: number;
  autoMatched: number;
  suggested: number;
  divergences: number;
  byRule: Partial<Record<RuleCode, number>>;
}

export interface ReconOutput {
  engineVersion: string;
  matches: ProposedMatch[];
  stats: ReconStats;
}
