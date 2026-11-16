import type { ItemKind } from '@concilia/core/shared';

export type Side = 'bank' | 'ledger';
export type ItemStatus = 'pending' | 'divergent' | 'reconciled' | 'ignored' | 'awaiting_approval';
export type MatchStatus = 'suggested' | 'pending_approval' | 'confirmed' | 'rejected' | 'superseded' | 'undone';

export const RECON_KEY = ['reconciliation'] as const;
/** Lista de itens/sugestões carregada por página (o servidor limita em 200). */
export const COUNT_LIMIT = 200;

export interface ReconItem {
  side: Side;
  id: string;
  bankAccountId: string | null;
  bankAccountName: string | null;
  batchId: string;
  rowNumber: number;
  date: string;
  dueDate: string | null;
  amountCents: number;
  description: string;
  descriptionNorm: string;
  externalId: string | null;
  document: string | null;
  reference: string | null;
  counterparty: string | null;
  identifiers: string[];
  kind: ItemKind;
  kindRule: string | null;
  categoryId: string | null;
  categoryName: string | null;
  status: ItemStatus;
  reconStatus: string;
  duplicateSuspect: boolean;
  activeMatch: { id: string; status: MatchStatus; type: string; ruleCode: string | null } | null;
  openSuggestions: number;
  createdAt: string;
}

export interface MatchItem {
  side: Side;
  id: string;
  date: string;
  amountCents: number;
  description: string;
  document: string | null;
  reference: string | null;
  externalId: string | null;
  kind: ItemKind;
  active: boolean;
}

export interface Match {
  id: string;
  bankAccountName: string | null;
  type: string;
  status: MatchStatus;
  origin: 'engine' | 'user';
  autoConfirmed: boolean;
  ruleCode: string | null;
  ruleLabel: string | null;
  confidence: number | null;
  breakdown: unknown;
  explanation: string | null;
  differenceCents: number;
  dateDiffDays: number;
  divergence: 'amount' | 'date' | 'duplicate' | null;
  ambiguous: boolean;
  categoryName: string | null;
  proposedByName: string | null;
  proposedAt: string | null;
  proposalNote: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  undoneByName: string | null;
  undoneAt: string | null;
  undoReason: string | null;
  createdAt: string;
  bank: MatchItem[];
  ledger: MatchItem[];
  totals: { bankCents: number; ledgerCents: number };
}

export interface ItemDetail {
  item: ReconItem;
  raw: unknown;
  history: Match[];
}

export interface Run {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  stats: { autoMatched?: number; suggested?: number; divergences?: number };
  error: string | null;
}

export interface Filters {
  bankAccountId: string;
  dateFrom: string;
  dateTo: string;
  q: string;
  kind: string;
  direction: string;
  amountMin: string;
  amountMax: string;
}

export const EMPTY_FILTERS: Filters = {
  bankAccountId: '', dateFrom: '', dateTo: '', q: '', kind: '', direction: '', amountMin: '', amountMax: '',
};

export type DetailTarget = { type: 'match'; id: string } | { type: 'item'; side: Side; id: string } | null;

export const MATCH_STATUS_LABEL: Record<string, string> = {
  suggested: 'Sugerida',
  pending_approval: 'Aguardando aprovação',
  confirmed: 'Confirmada',
  rejected: 'Rejeitada',
  superseded: 'Substituída',
  undone: 'Desfeita',
};
