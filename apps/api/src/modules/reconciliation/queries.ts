import {
  ENGINE_MATCH_TYPES,
  ITEM_KINDS,
  normalizeDescription,
  normalizeIdentifier,
  RULE_LABELS,
  type ItemKind,
  type RuleCode,
} from '@concilia/core';
import { z } from 'zod';
import type { Db } from '../../db/context';
import { badRequest, notFound } from '../../http/errors';

export const RECON_JOB_TYPE = 'reconciliation.run';

export type Side = 'bank' | 'ledger';
export type ReconStatus = 'pending' | 'reconciled' | 'divergent' | 'ignored';

/** Situação exibida do item: a do registro, ou "aguardando aprovação" quando reservado por proposta pendente. */
export const ITEM_STATUSES = ['pending', 'divergent', 'reconciled', 'ignored', 'awaiting_approval'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const MATCH_STATUSES = ['suggested', 'pending_approval', 'confirmed', 'rejected', 'superseded', 'undone'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const MATCH_TYPES = [...ENGINE_MATCH_TYPES, 'manual', 'ignored'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

// ---------------------------------------------------------------------------
// Itens (extrato e lançamentos)
// ---------------------------------------------------------------------------

const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

/** Filtros de itens. Reutilizado pela exportação (E9). Valores em centavos; faixa de valor sobre o valor absoluto. */
export const reconItemFiltersSchema = z.object({
  side: z.enum(['bank', 'ledger']).optional(),
  bankAccountId: z.uuid().optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  hasSuggestion: z.union([z.boolean(), booleanQuery]).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  amountMin: z.coerce.number().int().min(0).optional(),
  amountMax: z.coerce.number().int().min(0).optional(),
  direction: z.enum(['credit', 'debit']).optional(),
  q: z.string().trim().min(1).max(120).optional(),
});
export type ReconItemFilters = z.infer<typeof reconItemFiltersSchema>;

export interface ReconItemView {
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
  reconStatus: ReconStatus;
  duplicateSuspect: boolean;
  /** Conciliação vigente ou aguardando aprovação que reserva o item. */
  activeMatch: { id: string; status: MatchStatus; type: MatchType; ruleCode: string | null } | null;
  openSuggestions: number;
  createdAt: string;
}

interface ItemRow {
  side: Side;
  id: string;
  bank_account_id: string | null;
  bank_account_name: string | null;
  batch_id: string;
  row_number: number;
  date: string;
  due_date: string | null;
  amount_cents: string;
  description_raw: string;
  description_norm: string;
  external_id: string | null;
  document: string | null;
  reference: string | null;
  counterparty: string | null;
  identifiers: string[];
  kind: ItemKind;
  kind_rule: string | null;
  category_id: string | null;
  category_name: string | null;
  status: ItemStatus;
  recon_status: ReconStatus;
  duplicate_suspect: boolean;
  active_match_id: string | null;
  active_match_status: MatchStatus | null;
  active_match_type: MatchType | null;
  active_match_rule: string | null;
  open_suggestions: number;
  created_at: Date;
}

const STATUS_EXPR = `CASE WHEN am.status = 'pending_approval' THEN 'awaiting_approval' ELSE t.recon_status END`;

function itemColumn(side: Side): string {
  return side === 'bank' ? 'bank_transaction_id' : 'ledger_entry_id';
}

/** SELECT de um lado, com a conciliação ativa e a contagem de sugestões abertas. */
function itemSelect(side: Side): string {
  const bank = side === 'bank';
  const column = itemColumn(side);
  const category = bank
    ? `CASE WHEN am.status = 'confirmed' AND am.category_id IS NOT NULL THEN am.category_id ELSE t.category_id END`
    : `CASE WHEN am.status = 'confirmed' THEN am.category_id END`;
  return `
    SELECT '${side}'::text AS side, t.id, t.bank_account_id, a.name AS bank_account_name, t.batch_id, t.row_number,
           ${bank ? 't.posted_date' : 't.entry_date'} AS date, ${bank ? 'NULL::date' : 't.due_date'} AS due_date,
           t.amount_cents::text AS amount_cents, t.description_raw, t.description_norm, t.external_id, t.document,
           t.reference, ${bank ? 'NULL::text' : 't.counterparty'} AS counterparty, t.identifiers, t.kind,
           ${bank ? 't.kind_rule' : 'NULL::text'} AS kind_rule, cat.id AS category_id, cat.name AS category_name,
           ${STATUS_EXPR} AS status, t.recon_status, ${bank ? 't.duplicate_suspect' : 'false'} AS duplicate_suspect,
           am.id AS active_match_id, am.status AS active_match_status, am.match_type AS active_match_type,
           am.rule_code AS active_match_rule,
           (SELECT count(*)::int FROM match_items si
              JOIN matches sm ON sm.tenant_id = si.tenant_id AND sm.id = si.match_id
             WHERE si.tenant_id = t.tenant_id AND si.${column} = t.id AND sm.status = 'suggested') AS open_suggestions,
           t.created_at
      FROM ${bank ? 'bank_transactions' : 'ledger_entries'} t
      LEFT JOIN bank_accounts a ON a.tenant_id = t.tenant_id AND a.id = t.bank_account_id
      LEFT JOIN LATERAL (
        SELECT m.id, m.status, m.match_type, m.rule_code, m.category_id
          FROM match_items i JOIN matches m ON m.tenant_id = i.tenant_id AND m.id = i.match_id
         WHERE i.tenant_id = t.tenant_id AND i.${column} = t.id AND i.active
         LIMIT 1
      ) am ON true
      LEFT JOIN categories cat ON cat.tenant_id = t.tenant_id AND cat.id = ${category}`;
}

function itemView(row: ItemRow): ReconItemView {
  return {
    side: row.side,
    id: row.id,
    bankAccountId: row.bank_account_id,
    bankAccountName: row.bank_account_name,
    batchId: row.batch_id,
    rowNumber: row.row_number,
    date: row.date,
    dueDate: row.due_date,
    amountCents: Number(row.amount_cents),
    description: row.description_raw,
    descriptionNorm: row.description_norm,
    externalId: row.external_id,
    document: row.document,
    reference: row.reference,
    counterparty: row.counterparty,
    identifiers: row.identifiers,
    kind: row.kind,
    kindRule: row.kind_rule,
    categoryId: row.category_id,
    categoryName: row.category_name,
    status: row.status,
    reconStatus: row.recon_status,
    duplicateSuspect: row.duplicate_suspect,
    activeMatch:
      row.active_match_id && row.active_match_status && row.active_match_type
        ? { id: row.active_match_id, status: row.active_match_status, type: row.active_match_type, ruleCode: row.active_match_rule }
        : null,
    openSuggestions: row.open_suggestions,
    createdAt: row.created_at.toISOString(),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

interface ItemCursor {
  date: string;
  side: Side;
  id: string;
}

function encodeItemCursor(cursor: ItemCursor): string {
  return Buffer.from(JSON.stringify([cursor.date, cursor.side, cursor.id]), 'utf8').toString('base64url');
}

function decodeItemCursor(value: string): ItemCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[0] === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed[0]) &&
      (parsed[1] === 'bank' || parsed[1] === 'ledger') &&
      typeof parsed[2] === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed[2])
    ) {
      return { date: parsed[0], side: parsed[1], id: parsed[2] };
    }
  } catch {
    // segue para o erro abaixo
  }
  throw badRequest('Cursor de paginação inválido.', 'invalid_cursor');
}

export interface ItemPage {
  limit: number;
  cursor?: string | null;
}

/**
 * Condições de filtro de um lado (extrato ou lançamentos), compartilhadas pela listagem e pelas contagens.
 * `withStatus` falso ignora o filtro de situação (as contagens agrupam por ela).
 */
function itemConditions(
  filters: ReconItemFilters,
  param: (value: unknown, cast?: string) => string,
  withStatus: boolean,
): (side: Side) => string[] {
  const ph = {
    account: filters.bankAccountId ? param(filters.bankAccountId, '::uuid') : null,
    status: withStatus && filters.status ? param(filters.status) : null,
    kind: filters.kind ? param(filters.kind) : null,
    dateFrom: filters.dateFrom ? param(filters.dateFrom, '::date') : null,
    dateTo: filters.dateTo ? param(filters.dateTo, '::date') : null,
    amountMin: filters.amountMin !== undefined ? param(filters.amountMin, '::bigint') : null,
    amountMax: filters.amountMax !== undefined ? param(filters.amountMax, '::bigint') : null,
    like: filters.q ? param(`%${escapeLike(filters.q)}%`) : null,
    likeNorm: filters.q ? param(`%${escapeLike(normalizeDescription(filters.q))}%`) : null,
    identifier: filters.q ? param(normalizeIdentifier(filters.q) ?? '') : null,
  };
  return (side) => {
    const date = side === 'bank' ? 't.posted_date' : 't.entry_date';
    const where = ['t.tenant_id = $1'];
    if (ph.account) where.push(`t.bank_account_id = ${ph.account}`);
    if (ph.status) where.push(`${STATUS_EXPR} = ${ph.status}`);
    if (ph.kind) where.push(`t.kind = ${ph.kind}`);
    if (ph.dateFrom) where.push(`${date} >= ${ph.dateFrom}`);
    if (ph.dateTo) where.push(`${date} <= ${ph.dateTo}`);
    if (ph.amountMin) where.push(`abs(t.amount_cents) >= ${ph.amountMin}`);
    if (ph.amountMax) where.push(`abs(t.amount_cents) <= ${ph.amountMax}`);
    if (filters.direction) where.push(filters.direction === 'credit' ? 't.amount_cents > 0' : 't.amount_cents < 0');
    if (filters.hasSuggestion !== undefined) {
      where.push(
        `${filters.hasSuggestion ? '' : 'NOT '}EXISTS (
           SELECT 1 FROM match_items si JOIN matches sm ON sm.tenant_id = si.tenant_id AND sm.id = si.match_id
            WHERE si.tenant_id = t.tenant_id AND si.${itemColumn(side)} = t.id AND sm.status = 'suggested')`,
      );
    }
    if (ph.like && ph.likeNorm && ph.identifier) {
      const counterparty = side === 'ledger' ? ` OR t.counterparty ILIKE ${ph.like}` : '';
      where.push(
        `(t.description_raw ILIKE ${ph.like} OR t.description_norm LIKE ${ph.likeNorm} OR t.document ILIKE ${ph.like}
          OR t.reference ILIKE ${ph.like} OR t.external_id ILIKE ${ph.like} OR ${ph.identifier} = ANY (t.identifiers)${counterparty})`,
      );
    }
    return where;
  };
}

/** Contagem de itens (extrato e lançamentos) por situação exibida, com os mesmos filtros da listagem. */
export async function countReconItems(
  db: Db,
  tenantId: string,
  filters: ReconItemFilters,
): Promise<Record<ItemStatus, number>> {
  const values: unknown[] = [tenantId];
  const param = (value: unknown, cast = ''): string => {
    values.push(value);
    return `$${values.length}${cast}`;
  };
  const conditions = itemConditions(filters, param, false);
  const sides: Side[] = filters.side ? [filters.side] : ['bank', 'ledger'];
  const result = await db.query<{ status: ItemStatus; n: string }>(
    `SELECT x.status, count(*) AS n FROM (${sides
      .map((side) => `${itemSelect(side)} WHERE ${conditions(side).join(' AND ')}`)
      .map((sql) => `(${sql})`)
      .join(' UNION ALL ')}) x GROUP BY x.status`,
    values,
  );
  const counts: Record<ItemStatus, number> = { pending: 0, divergent: 0, reconciled: 0, ignored: 0, awaiting_approval: 0 };
  for (const row of result.rows) counts[row.status] = Number(row.n);
  return counts;
}

/**
 * Itens de extrato e lançamentos com os filtros da revisão, em ordem de data decrescente.
 * Sem `side`, une os dois lados. Paginação por cursor opaco (data, lado, id).
 */
export async function queryReconItems(
  db: Db,
  tenantId: string,
  filters: ReconItemFilters,
  page: ItemPage,
): Promise<{ items: ReconItemView[]; nextCursor?: string }> {
  const values: unknown[] = [tenantId];
  const param = (value: unknown, cast = ''): string => {
    values.push(value);
    return `$${values.length}${cast}`;
  };
  const cursor = page.cursor ? decodeItemCursor(page.cursor) : null;
  const cursorPh = cursor
    ? { date: param(cursor.date, '::date'), side: param(cursor.side, '::text'), id: param(cursor.id, '::uuid') }
    : null;
  const limitPh = param(page.limit + 1, '::int');
  const conditions = itemConditions(filters, param, true);

  const branch = (side: Side): string => {
    const date = side === 'bank' ? 't.posted_date' : 't.entry_date';
    const where = conditions(side);
    if (cursorPh) where.push(`(${date}, '${side}'::text, t.id) < (${cursorPh.date}, ${cursorPh.side}, ${cursorPh.id})`);
    return `(${itemSelect(side)} WHERE ${where.join(' AND ')}
             ORDER BY ${date} DESC, t.id DESC LIMIT ${limitPh})`;
  };

  const sides: Side[] = filters.side ? [filters.side] : ['bank', 'ledger'];
  const result = await db.query<ItemRow>(
    `SELECT * FROM (${sides.map(branch).join(' UNION ALL ')}) x
      ORDER BY x.date DESC, x.side DESC, x.id DESC LIMIT ${limitPh}`,
    values,
  );
  const rows = result.rows.slice(0, page.limit);
  const items = rows.map(itemView);
  const last = rows.at(-1);
  return result.rows.length > page.limit && last
    ? { items, nextCursor: encodeItemCursor({ date: last.date, side: last.side, id: last.id }) }
    : { items };
}

/** Um item com a linha bruta. 404 se não existir na empresa. */
export async function findReconItem(
  db: Db,
  tenantId: string,
  side: Side,
  id: string,
): Promise<{ item: ReconItemView; raw: unknown }> {
  const result = await db.query<ItemRow & { raw: unknown }>(
    `SELECT x.*, r.raw FROM (${itemSelect(side)} WHERE t.tenant_id = $1 AND t.id = $2) x
       JOIN ${side === 'bank' ? 'bank_transactions' : 'ledger_entries'} r ON r.tenant_id = $1 AND r.id = x.id`,
    [tenantId, id],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Item não encontrado.');
  return { item: itemView(row), raw: row.raw };
}

// ---------------------------------------------------------------------------
// Conciliações
// ---------------------------------------------------------------------------

export interface MatchRow {
  id: string;
  tenant_id: string;
  run_id: string | null;
  bank_account_id: string | null;
  match_type: MatchType;
  status: MatchStatus;
  origin: 'engine' | 'user';
  auto_confirmed: boolean;
  rule_code: string | null;
  engine_version: string | null;
  confidence: string | null;
  breakdown: unknown;
  explanation: string | null;
  difference_cents: string;
  date_diff_days: number;
  divergence: 'amount' | 'date' | 'duplicate' | null;
  ambiguous: boolean;
  category_id: string | null;
  pair_key: string;
  proposed_by: string | null;
  proposed_at: Date | null;
  proposal_note: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  undone_by: string | null;
  undone_at: Date | null;
  undo_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MatchListRow extends MatchRow {
  cursor_at: string;
  bank_account_name: string | null;
  category_name: string | null;
  proposed_by_name: string | null;
  decided_by_name: string | null;
  undone_by_name: string | null;
}

const MATCH_SELECT = `
  SELECT m.*, m.created_at::text AS cursor_at, a.name AS bank_account_name, c.name AS category_name,
         pu.name AS proposed_by_name, du.name AS decided_by_name, uu.name AS undone_by_name
    FROM matches m
    LEFT JOIN bank_accounts a ON a.tenant_id = m.tenant_id AND a.id = m.bank_account_id
    LEFT JOIN categories c ON c.tenant_id = m.tenant_id AND c.id = m.category_id
    LEFT JOIN users pu ON pu.tenant_id = m.tenant_id AND pu.id = m.proposed_by
    LEFT JOIN users du ON du.tenant_id = m.tenant_id AND du.id = m.decided_by
    LEFT JOIN users uu ON uu.tenant_id = m.tenant_id AND uu.id = m.undone_by`;

export interface MatchItemView {
  side: Side;
  id: string;
  bankAccountId: string | null;
  date: string;
  amountCents: number;
  description: string;
  document: string | null;
  reference: string | null;
  externalId: string | null;
  kind: ItemKind;
  reconStatus: ReconStatus;
  /** O item está reservado por esta conciliação. */
  active: boolean;
}

interface MatchItemRow {
  match_id: string;
  side: Side;
  id: string;
  bank_account_id: string | null;
  date: string;
  amount_cents: string;
  description: string;
  document: string | null;
  reference: string | null;
  external_id: string | null;
  kind: ItemKind;
  recon_status: ReconStatus;
  active: boolean;
}

export async function loadMatchItems(db: Db, tenantId: string, matchIds: string[]): Promise<Map<string, MatchItemView[]>> {
  const map = new Map<string, MatchItemView[]>();
  if (matchIds.length === 0) return map;
  const result = await db.query<MatchItemRow>(
    `SELECT i.match_id, i.side, i.active, coalesce(b.id, l.id) AS id,
            coalesce(b.bank_account_id, l.bank_account_id) AS bank_account_id,
            coalesce(b.posted_date, l.entry_date) AS date, coalesce(b.amount_cents, l.amount_cents)::text AS amount_cents,
            coalesce(b.description_raw, l.description_raw) AS description, coalesce(b.document, l.document) AS document,
            coalesce(b.reference, l.reference) AS reference, coalesce(b.external_id, l.external_id) AS external_id,
            coalesce(b.kind, l.kind) AS kind, coalesce(b.recon_status, l.recon_status) AS recon_status
       FROM match_items i
       LEFT JOIN bank_transactions b ON b.tenant_id = i.tenant_id AND b.id = i.bank_transaction_id
       LEFT JOIN ledger_entries l ON l.tenant_id = i.tenant_id AND l.id = i.ledger_entry_id
      WHERE i.tenant_id = $1 AND i.match_id = ANY ($2::uuid[])
      ORDER BY coalesce(b.posted_date, l.entry_date), i.id`,
    [tenantId, matchIds],
  );
  for (const row of result.rows) {
    const list = map.get(row.match_id) ?? [];
    list.push({
      side: row.side,
      id: row.id,
      bankAccountId: row.bank_account_id,
      date: row.date,
      amountCents: Number(row.amount_cents),
      description: row.description,
      document: row.document,
      reference: row.reference,
      externalId: row.external_id,
      kind: row.kind,
      reconStatus: row.recon_status,
      active: row.active,
    });
    map.set(row.match_id, list);
  }
  return map;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function matchView(row: MatchListRow, items: MatchItemView[]) {
  const bank = items.filter((item) => item.side === 'bank');
  const ledger = items.filter((item) => item.side === 'ledger');
  const sum = (list: MatchItemView[]) => list.reduce((total, item) => total + item.amountCents, 0);
  return {
    id: row.id,
    runId: row.run_id,
    bankAccountId: row.bank_account_id,
    bankAccountName: row.bank_account_name,
    type: row.match_type,
    status: row.status,
    origin: row.origin,
    autoConfirmed: row.auto_confirmed,
    ruleCode: row.rule_code,
    ruleLabel: row.rule_code && row.rule_code in RULE_LABELS ? RULE_LABELS[row.rule_code as RuleCode] : null,
    engineVersion: row.engine_version,
    confidence: row.confidence === null ? null : Number(row.confidence),
    breakdown: row.breakdown,
    explanation: row.explanation,
    differenceCents: Number(row.difference_cents),
    dateDiffDays: row.date_diff_days,
    divergence: row.divergence,
    ambiguous: row.ambiguous,
    categoryId: row.category_id,
    categoryName: row.category_name,
    proposedBy: row.proposed_by,
    proposedByName: row.proposed_by_name,
    proposedAt: iso(row.proposed_at),
    proposalNote: row.proposal_note,
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    decidedAt: iso(row.decided_at),
    decisionNote: row.decision_note,
    undoneBy: row.undone_by,
    undoneByName: row.undone_by_name,
    undoneAt: iso(row.undone_at),
    undoReason: row.undo_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    bank,
    ledger,
    totals: { bankCents: sum(bank), ledgerCents: sum(ledger) },
  };
}
export type MatchView = ReturnType<typeof matchView>;

/** Linha da conciliação (sem itens). 404 se não existir na empresa. */
export async function findMatchRow(db: Db, tenantId: string, id: string, forUpdate = false): Promise<MatchRow> {
  const result = await db.query<MatchRow>(
    `SELECT * FROM matches WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenantId, id],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Conciliação não encontrada.');
  return row;
}

export async function getMatchView(db: Db, tenantId: string, id: string): Promise<MatchView> {
  const result = await db.query<MatchListRow>(`${MATCH_SELECT} WHERE m.tenant_id = $1 AND m.id = $2`, [tenantId, id]);
  const row = result.rows[0];
  if (!row) throw notFound('Conciliação não encontrada.');
  const items = await loadMatchItems(db, tenantId, [row.id]);
  return matchView(row, items.get(row.id) ?? []);
}

export const matchFiltersSchema = z.object({
  status: z.enum(MATCH_STATUSES).optional(),
  type: z.enum(MATCH_TYPES).optional(),
  bankAccountId: z.uuid().optional(),
  runId: z.uuid().optional(),
  divergent: booleanQuery.optional(),
  ambiguous: booleanQuery.optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  // Filtros sobre os itens da conciliação: vale se ao menos um item satisfaz todos.
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  amountMin: z.coerce.number().int().min(0).optional(),
  amountMax: z.coerce.number().int().min(0).optional(),
  direction: z.enum(['credit', 'debit']).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  q: z.string().trim().min(1).max(120).optional(),
});
export type MatchFilters = z.infer<typeof matchFiltersSchema>;

/** Condições de filtro de `matches` (alias `m`); `values` já traz o tenantId em `$1`. */
function matchConditions(filters: MatchFilters, values: unknown[]): string[] {
  const where = ['m.tenant_id = $1'];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };
  if (filters.status) add('m.status = ?', filters.status);
  if (filters.type) add('m.match_type = ?', filters.type);
  if (filters.bankAccountId) add('m.bank_account_id = ?', filters.bankAccountId);
  if (filters.runId) add('m.run_id = ?', filters.runId);
  if (filters.divergent !== undefined) where.push(filters.divergent ? 'm.divergence IS NOT NULL' : 'm.divergence IS NULL');
  if (filters.ambiguous !== undefined) where.push(filters.ambiguous ? 'm.ambiguous' : 'NOT m.ambiguous');
  if (filters.minConfidence !== undefined) add('m.confidence >= ?', filters.minConfidence);
  const item: string[] = [];
  const addItem = (clause: string, value: unknown) => {
    values.push(value);
    item.push(clause.replace('?', `$${values.length}`));
  };
  if (filters.dateFrom) addItem('coalesce(b.posted_date, l.entry_date) >= ?::date', filters.dateFrom);
  if (filters.dateTo) addItem('coalesce(b.posted_date, l.entry_date) <= ?::date', filters.dateTo);
  if (filters.amountMin !== undefined) addItem('abs(coalesce(b.amount_cents, l.amount_cents)) >= ?::bigint', filters.amountMin);
  if (filters.amountMax !== undefined) addItem('abs(coalesce(b.amount_cents, l.amount_cents)) <= ?::bigint', filters.amountMax);
  if (filters.direction) item.push(`coalesce(b.amount_cents, l.amount_cents) ${filters.direction === 'credit' ? '> 0' : '< 0'}`);
  if (filters.kind) addItem('coalesce(b.kind, l.kind) = ?', filters.kind);
  if (filters.q) {
    values.push(`%${escapeLike(filters.q)}%`, `%${escapeLike(normalizeDescription(filters.q))}%`, normalizeIdentifier(filters.q) ?? '');
    const [like, likeNorm, identifier] = [values.length - 2, values.length - 1, values.length].map((n) => `$${n}`);
    item.push(
      `(coalesce(b.description_raw, l.description_raw) ILIKE ${like} OR coalesce(b.description_norm, l.description_norm) LIKE ${likeNorm}
        OR coalesce(b.document, l.document) ILIKE ${like} OR coalesce(b.reference, l.reference) ILIKE ${like}
        OR coalesce(b.external_id, l.external_id) ILIKE ${like} OR ${identifier} = ANY (coalesce(b.identifiers, l.identifiers))
        OR l.counterparty ILIKE ${like})`,
    );
  }
  if (item.length > 0) {
    where.push(
      `EXISTS (SELECT 1 FROM match_items mi
                 LEFT JOIN bank_transactions b ON b.tenant_id = mi.tenant_id AND b.id = mi.bank_transaction_id
                 LEFT JOIN ledger_entries l ON l.tenant_id = mi.tenant_id AND l.id = mi.ledger_entry_id
                WHERE mi.tenant_id = m.tenant_id AND mi.match_id = m.id AND ${item.join(' AND ')})`,
    );
  }
  return where;
}

/** Quantidade de conciliações (de uma situação) que atendem aos filtros. */
export async function countMatches(db: Db, tenantId: string, filters: MatchFilters): Promise<number> {
  const values: unknown[] = [tenantId];
  const where = matchConditions(filters, values);
  const result = await db.query<{ n: string }>(`SELECT count(*) AS n FROM matches m WHERE ${where.join(' AND ')}`, values);
  return Number(result.rows[0]?.n ?? 0);
}

export async function queryMatches(
  db: Db,
  tenantId: string,
  filters: MatchFilters,
  page: { limit: number; cursor?: { at: string; id: string } | null },
): Promise<{ rows: MatchView[]; hasMore: boolean; last: { at: string; id: string } | null }> {
  const values: unknown[] = [tenantId];
  const where = matchConditions(filters, values);
  if (page.cursor) {
    values.push(page.cursor.at, page.cursor.id);
    where.push(`(m.created_at, m.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(page.limit + 1);
  const result = await db.query<MatchListRow>(
    `${MATCH_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT $${values.length}`,
    values,
  );
  const rows = result.rows.slice(0, page.limit);
  const items = await loadMatchItems(db, tenantId, rows.map((row) => row.id));
  const last = rows.at(-1);
  return {
    rows: rows.map((row) => matchView(row, items.get(row.id) ?? [])),
    hasMore: result.rows.length > page.limit,
    last: last ? { at: last.cursor_at, id: last.id } : null,
  };
}

/** Todas as conciliações (de qualquer situação) de que o item participa, da mais recente à mais antiga. */
export async function itemHistory(db: Db, tenantId: string, side: Side, id: string): Promise<MatchView[]> {
  const result = await db.query<MatchListRow>(
    `${MATCH_SELECT}
      WHERE m.tenant_id = $1
        AND EXISTS (SELECT 1 FROM match_items i WHERE i.tenant_id = m.tenant_id AND i.match_id = m.id AND i.${itemColumn(side)} = $2)
      ORDER BY m.created_at DESC, m.id DESC`,
    [tenantId, id],
  );
  const items = await loadMatchItems(db, tenantId, result.rows.map((row) => row.id));
  return result.rows.map((row) => matchView(row, items.get(row.id) ?? []));
}

// ---------------------------------------------------------------------------
// Execuções
// ---------------------------------------------------------------------------

export interface RunRow {
  id: string;
  tenant_id: string;
  bank_account_id: string;
  bank_account_name: string | null;
  period_start: string;
  period_end: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  rules_snapshot: unknown;
  engine_version: string | null;
  stats: Record<string, unknown>;
  error: string | null;
  started_by: string | null;
  created_at: Date;
  finished_at: Date | null;
  cursor_at: string;
  job_id: string | null;
  job_status: string | null;
  job_attempts: number | null;
  job_last_error: string | null;
}

export const RUN_SELECT = `
  SELECT r.*, a.name AS bank_account_name, r.created_at::text AS cursor_at,
         j.id AS job_id, j.status AS job_status, j.attempts AS job_attempts, j.last_error AS job_last_error
    FROM reconciliation_runs r
    LEFT JOIN bank_accounts a ON a.tenant_id = r.tenant_id AND a.id = r.bank_account_id
    LEFT JOIN jobs j ON j.tenant_id = r.tenant_id AND j.type = '${RECON_JOB_TYPE}' AND j.idempotency_key = r.id::text`;

export function runView(row: RunRow) {
  return {
    id: row.id,
    bankAccountId: row.bank_account_id,
    bankAccountName: row.bank_account_name,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    rulesSnapshot: row.rules_snapshot,
    engineVersion: row.engine_version,
    stats: row.stats,
    error: row.error,
    startedBy: row.started_by,
    createdAt: row.created_at.toISOString(),
    finishedAt: iso(row.finished_at),
    job: row.job_id
      ? { id: row.job_id, status: row.job_status, attempts: row.job_attempts, lastError: row.job_last_error }
      : null,
  };
}

export async function findRun(db: Db, tenantId: string, id: string): Promise<RunRow> {
  const result = await db.query<RunRow>(`${RUN_SELECT} WHERE r.tenant_id = $1 AND r.id = $2`, [tenantId, id]);
  const row = result.rows[0];
  if (!row) throw notFound('Execução de conciliação não encontrada.');
  return row;
}
