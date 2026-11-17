import { normalizeDescription } from './text';

export const ITEM_KINDS = ['regular', 'fee', 'tax', 'interest', 'reversal', 'internal_transfer'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  regular: 'Comum',
  fee: 'Tarifa',
  tax: 'Imposto',
  interest: 'Juros e encargos',
  reversal: 'Estorno',
  internal_transfer: 'Transferência interna',
};

export const MATCH_TYPES = ['contains', 'starts_with', 'equals', 'contains_all'] as const;
export type RuleMatchType = (typeof MATCH_TYPES)[number];

/**
 * Regra de classificação por texto. Não há expressão regular definida pelo usuário,
 * para que uma regra mal escrita não possa travar o processamento de outras empresas.
 */
export interface ClassificationRule {
  id?: string;
  name: string;
  /** Menor número é avaliado primeiro. */
  priority: number;
  matchType: RuleMatchType;
  pattern: string;
  appliesTo: 'bank' | 'ledger' | 'both';
  direction: 'any' | 'credit' | 'debit';
  resultKind: ItemKind;
  categoryId: string | null;
  active: boolean;
}

export interface ClassifiableItem {
  side: 'bank' | 'ledger';
  descriptionNorm: string;
  amountCents: number;
}

export interface ClassificationResult {
  kind: ItemKind;
  ruleName: string | null;
  ruleId: string | null;
  categoryId: string | null;
}

function matches(description: string, rule: ClassificationRule): boolean {
  const pattern = normalizeDescription(rule.pattern);
  if (pattern === '') return false;
  switch (rule.matchType) {
    case 'equals':
      return description === pattern;
    case 'starts_with':
      return description === pattern || description.startsWith(`${pattern} `);
    case 'contains':
      // comparação por palavra inteira: "TAR" não casa com "GUITARRA"
      return ` ${description} `.includes(` ${pattern} `);
    case 'contains_all': {
      const words = new Set(description.split(' '));
      return pattern.split(' ').every((word) => words.has(word));
    }
  }
}

/** Aplica a primeira regra ativa que casa, por ordem de prioridade. Sem regra, o item é comum. */
export function classify(item: ClassifiableItem, rules: readonly ClassificationRule[]): ClassificationResult {
  const ordered = [...rules]
    .filter((rule) => rule.active)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  for (const rule of ordered) {
    if (rule.appliesTo !== 'both' && rule.appliesTo !== item.side) continue;
    if (rule.direction === 'credit' && item.amountCents <= 0) continue;
    if (rule.direction === 'debit' && item.amountCents >= 0) continue;
    if (matches(item.descriptionNorm, rule)) {
      return { kind: rule.resultKind, ruleName: rule.name, ruleId: rule.id ?? null, categoryId: rule.categoryId };
    }
  }
  return { kind: 'regular', ruleName: null, ruleId: null, categoryId: null };
}

type RuleSeed = [name: string, priority: number, pattern: string, kind: ItemKind, direction?: 'any' | 'credit' | 'debit'];

const SEEDS: RuleSeed[] = [
  // Estornos primeiro: "ESTORNO TARIFA" é estorno, não tarifa.
  ['Estorno', 10, 'ESTORNO', 'reversal'],
  ['Estorno (abreviado)', 10, 'EST', 'reversal'],
  ['Estornado', 10, 'ESTORNADO', 'reversal'],
  ['Devolução', 11, 'DEVOLUCAO', 'reversal'],
  ['Devolução (abreviado)', 11, 'DEV', 'reversal'],
  ['Devolvido', 11, 'DEVOLVIDO', 'reversal'],
  ['Transferência entre contas', 20, 'TRANSF ENTRE CONTAS', 'internal_transfer'],
  ['Transferência entre contas (extenso)', 20, 'TRANSFERENCIA ENTRE CONTAS', 'internal_transfer'],
  ['Mesma titularidade', 20, 'MESMA TITULARIDADE', 'internal_transfer'],
  ['IOF', 30, 'IOF', 'tax', 'debit'],
  ['IRRF', 30, 'IRRF', 'tax', 'debit'],
  ['Imposto de renda', 30, 'IMPOSTO DE RENDA', 'tax', 'debit'],
  ['Tarifa', 40, 'TARIFA', 'fee', 'debit'],
  ['Tarifas', 40, 'TARIFAS', 'fee', 'debit'],
  ['Tarifa (abreviado)', 40, 'TAR', 'fee', 'debit'],
  ['Cesta de serviços', 40, 'CESTA DE SERVICOS', 'fee', 'debit'],
  ['Pacote de serviços', 40, 'PACOTE DE SERVICOS', 'fee', 'debit'],
  ['Manutenção de conta', 40, 'MANUTENCAO DE CONTA', 'fee', 'debit'],
  ['Manutenção de conta (abreviado)', 40, 'MANUT CONTA', 'fee', 'debit'],
  ['Anuidade', 40, 'ANUIDADE', 'fee', 'debit'],
  ['Juros', 50, 'JUROS', 'interest', 'debit'],
  ['Encargos', 50, 'ENCARGOS', 'interest', 'debit'],
  ['Mora', 50, 'MORA', 'interest', 'debit'],
];

/** Regras iniciais com vocabulário usual de extratos brasileiros. Cada empresa pode editar as suas. */
export const DEFAULT_CLASSIFICATION_RULES: ClassificationRule[] = SEEDS.map(
  ([name, priority, pattern, resultKind, direction]) => ({
    name,
    priority,
    matchType: 'contains',
    pattern,
    appliesTo: 'bank',
    direction: direction ?? 'any',
    resultKind,
    categoryId: null,
    active: true,
  }),
);
