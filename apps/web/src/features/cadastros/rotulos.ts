import { ITEM_KIND_LABELS, ITEM_KINDS, MATCH_TYPES } from '@concilia/core/shared';
import type { SelectOption } from '../../components/Select';

export const ORG_KIND_LABELS = { unit: 'Unidade', department: 'Departamento', cost_center: 'Centro de custo' } as const;
export type OrgKind = keyof typeof ORG_KIND_LABELS;

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  asset: 'Ativo',
  liability: 'Passivo',
  equity: 'Patrimônio líquido',
  revenue: 'Receita',
  expense: 'Despesa',
};

export const CATEGORY_KIND_LABELS: Record<string, string> = {
  fee: 'Tarifa',
  tax: 'Imposto',
  interest: 'Juros e encargos',
  transfer: 'Transferência',
  revenue: 'Receita',
  expense: 'Despesa',
  other: 'Outros',
};

export const MATCH_TYPE_LABELS: Record<string, string> = {
  contains: 'Contém a palavra',
  starts_with: 'Começa com',
  equals: 'Igual a',
  contains_all: 'Contém todas as palavras',
};

export const APPLIES_TO_LABELS: Record<string, string> = { bank: 'Extrato bancário', ledger: 'Lançamentos', both: 'Ambos os lados' };
export const DIRECTION_LABELS: Record<string, string> = { any: 'Qualquer', credit: 'Entrada (crédito)', debit: 'Saída (débito)' };
export const REPORT_KIND_LABELS: Record<string, string> = { items: 'Itens', summary: 'Resumo' };

export const label = (map: Record<string, string>, key: string | null | undefined) => (key ? (map[key] ?? key) : '—');

export const options = (map: Record<string, string>): SelectOption[] =>
  Object.entries(map).map(([value, text]) => ({ value, label: text }));

export const ITEM_KIND_OPTIONS: SelectOption[] = ITEM_KINDS.map((k) => ({ value: k, label: ITEM_KIND_LABELS[k] }));
export const MATCH_TYPE_OPTIONS: SelectOption[] = MATCH_TYPES.map((k) => ({ value: k, label: MATCH_TYPE_LABELS[k] ?? k }));
