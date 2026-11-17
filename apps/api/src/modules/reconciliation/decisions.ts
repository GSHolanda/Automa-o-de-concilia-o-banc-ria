import { approvalRequired, pairKey, type ApprovalQuestion, type ApprovalSettings } from '@concilia/core';
import type { Db } from '../../db/context';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../http/errors';
import type { AuditInput } from '../../http/route';
import { emitNotification } from '../notifications/service';
import { findMatchRow, getMatchView, type MatchRow, type MatchView, type Side } from './queries';

/** O necessário para decidir: transação, autor, auditoria e regras de aprovação efetivas. */
export interface DecisionContext {
  db: Db;
  tenantId: string;
  userId: string | null;
  audit: (entry: AuditInput) => Promise<void>;
  /** Regras de aprovação com `enabled` já combinado com o módulo `approvals` ativo. */
  approvals: ApprovalSettings;
}

export interface ItemRef {
  side: Side;
  id: string;
}

const OPEN_RECON_STATUSES = ['pending', 'divergent'];

function alreadyReconciled(): AppError {
  return conflict('Um ou mais itens já têm conciliação vigente ou aguardando aprovação.', 'already_reconciled');
}

function split(refs: readonly ItemRef[]): { bank: string[]; ledger: string[] } {
  return {
    bank: refs.filter((ref) => ref.side === 'bank').map((ref) => ref.id),
    ledger: refs.filter((ref) => ref.side === 'ledger').map((ref) => ref.id),
  };
}

// ---------------------------------------------------------------------------
// Travas e reservas de itens
// ---------------------------------------------------------------------------

/**
 * Serializa decisões sobre os mesmos itens. As travas são tomadas em ordem, antes de qualquer linha de
 * `matches`, para que duas decisões concorrentes nunca esperem uma pela outra em ordem inversa.
 */
export async function lockItems(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('recon-item:' || s.x, 0))
       FROM (SELECT DISTINCT x FROM unnest($1::text[]) AS u(x) ORDER BY x) s`,
    [ids],
  );
}

export async function matchItemRefs(db: Db, tenantId: string, matchIds: readonly string[]): Promise<ItemRef[]> {
  if (matchIds.length === 0) return [];
  const result = await db.query<{ side: Side; id: string }>(
    `SELECT side, coalesce(bank_transaction_id, ledger_entry_id) AS id
       FROM match_items WHERE tenant_id = $1 AND match_id = ANY ($2::uuid[]) ORDER BY id`,
    [tenantId, matchIds],
  );
  return result.rows;
}

/** Algum dos itens está reservado por outra conciliação (vigente ou aguardando aprovação). */
async function anyActiveElsewhere(db: Db, tenantId: string, refs: readonly ItemRef[], matchId: string | null): Promise<boolean> {
  const { bank, ledger } = split(refs);
  const result = await db.query(
    `SELECT 1 FROM match_items
      WHERE tenant_id = $1 AND active AND match_id IS DISTINCT FROM $4::uuid
        AND (bank_transaction_id = ANY ($2::uuid[]) OR ledger_entry_id = ANY ($3::uuid[]))
      LIMIT 1`,
    [tenantId, bank, ledger, matchId],
  );
  return (result.rowCount ?? 0) > 0;
}

function isReservationConflict(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === '23505' || code === '40P01';
}

/**
 * Executa a reserva dos itens em ponto de salvamento: a violação do índice único de item ativo
 * (decisão concorrente que chegou antes) vira 409 `already_reconciled`.
 */
async function guardReservation(db: Db, fn: () => Promise<void>): Promise<void> {
  await db.query('SAVEPOINT recon_reserve');
  try {
    await fn();
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT recon_reserve');
    if (isReservationConflict(error)) throw alreadyReconciled();
    throw error;
  }
  await db.query('RELEASE SAVEPOINT recon_reserve');
}

async function setActive(db: Db, tenantId: string, matchId: string, active: boolean): Promise<void> {
  await db.query('UPDATE match_items SET active = $3 WHERE tenant_id = $1 AND match_id = $2', [tenantId, matchId, active]);
}

/** Grava os itens de uma conciliação. Com `active`, os itens ficam reservados. */
export async function insertMatchItems(
  db: Db,
  tenantId: string,
  matchId: string,
  bankIds: readonly string[],
  ledgerIds: readonly string[],
  active: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO match_items (tenant_id, match_id, side, bank_transaction_id, ledger_entry_id, active)
     SELECT $1::uuid, $2::uuid, 'bank', b, NULL::uuid, $5::boolean FROM unnest($3::uuid[]) AS b
     UNION ALL
     SELECT $1::uuid, $2::uuid, 'ledger', NULL::uuid, l, $5::boolean FROM unnest($4::uuid[]) AS l`,
    [tenantId, matchId, bankIds, ledgerIds, active],
  );
}

/** Situação derivada dos itens (os dados de origem não mudam). */
export async function setReconStatus(
  db: Db,
  tenantId: string,
  refs: readonly ItemRef[],
  status: 'pending' | 'reconciled' | 'divergent' | 'ignored',
  onlyFrom?: readonly string[],
): Promise<void> {
  const { bank, ledger } = split(refs);
  const from = onlyFrom ? ' AND recon_status = ANY ($4::text[])' : '';
  const params = (ids: string[]) => (onlyFrom ? [tenantId, ids, status, onlyFrom] : [tenantId, ids, status]);
  if (bank.length > 0) {
    await db.query(
      `UPDATE bank_transactions SET recon_status = $3 WHERE tenant_id = $1 AND id = ANY ($2::uuid[])${from}`,
      params(bank),
    );
  }
  if (ledger.length > 0) {
    await db.query(
      `UPDATE ledger_entries SET recon_status = $3 WHERE tenant_id = $1 AND id = ANY ($2::uuid[])${from}`,
      params(ledger),
    );
  }
}

/**
 * Itens divergentes voltam a pendente quando nada mais os mantém divergentes: sem reserva ativa e sem
 * outra sugestão ou proposta aberta com divergência (inclui a possível duplicidade da importação).
 */
export async function releaseDivergent(db: Db, tenantId: string, refs: readonly ItemRef[]): Promise<void> {
  const { bank, ledger } = split(refs);
  const sides: Array<[string, string, string[]]> = [
    ['bank_transactions', 'bank_transaction_id', bank],
    ['ledger_entries', 'ledger_entry_id', ledger],
  ];
  for (const [table, column, ids] of sides) {
    if (ids.length === 0) continue;
    await db.query(
      `UPDATE ${table} t SET recon_status = 'pending'
        WHERE t.tenant_id = $1 AND t.id = ANY ($2::uuid[]) AND t.recon_status = 'divergent'
          AND NOT EXISTS (SELECT 1 FROM match_items i WHERE i.tenant_id = t.tenant_id AND i.${column} = t.id AND i.active)
          AND NOT EXISTS (
            SELECT 1 FROM match_items i JOIN matches m ON m.tenant_id = i.tenant_id AND m.id = i.match_id
             WHERE i.tenant_id = t.tenant_id AND i.${column} = t.id
               AND m.status IN ('suggested', 'pending_approval') AND m.divergence IS NOT NULL)`,
      [tenantId, ids],
    );
  }
}

/** Sugestões abertas que disputam algum dos itens passam a `superseded`. */
export async function supersedeCompetitors(db: Db, tenantId: string, matchId: string, refs: readonly ItemRef[]): Promise<void> {
  const { bank, ledger } = split(refs);
  const superseded = await db.query<{ id: string }>(
    `UPDATE matches m SET status = 'superseded'
      WHERE m.tenant_id = $1 AND m.id <> $2 AND m.status = 'suggested'
        AND EXISTS (
          SELECT 1 FROM match_items i
           WHERE i.tenant_id = m.tenant_id AND i.match_id = m.id
             AND (i.bank_transaction_id = ANY ($3::uuid[]) OR i.ledger_entry_id = ANY ($4::uuid[])))
      RETURNING m.id`,
    [tenantId, matchId, bank, ledger],
  );
  const others = await matchItemRefs(db, tenantId, superseded.rows.map((row) => row.id));
  await releaseDivergent(db, tenantId, others);
}

// ---------------------------------------------------------------------------
// Aprovação
// ---------------------------------------------------------------------------

function questionFor(match: Pick<MatchRow, 'match_type' | 'difference_cents' | 'divergence' | 'ambiguous'>): ApprovalQuestion {
  return {
    operation:
      match.match_type === 'classification' ? 'classification' : match.match_type === 'ignored' ? 'ignore' : 'suggestion',
    hasDifference: Number(match.difference_cents) !== 0 || match.divergence === 'amount' || match.divergence === 'date',
    ambiguous: match.ambiguous,
    grouped: match.match_type === 'group',
  };
}

/** Aviso interno a quem pode aprovar. Com quatro olhos, quem propôs não é avisado. */
async function notifyApprovers(dc: DecisionContext, matchId: string, summary: string): Promise<void> {
  await emitNotification(dc.db, {
    tenantId: dc.tenantId,
    event: 'approval.requested',
    title: 'Conciliação aguardando aprovação',
    body: summary,
    link: `/aprovacoes?match=${matchId}`,
    data: { matchId, proposedBy: dc.userId },
    defaultRecipients: { permission: 'reconciliation.approve', excludeUserId: dc.approvals.fourEyes ? dc.userId : null },
  });
}

/** Confirma a conciliação: itens reservados passam a conciliados (ou ignorados, para o tipo `ignored`). */
async function markItemsDecided(dc: DecisionContext, match: Pick<MatchRow, 'match_type'>, refs: readonly ItemRef[]) {
  await setReconStatus(dc.db, dc.tenantId, refs, match.match_type === 'ignored' ? 'ignored' : 'reconciled');
}

/** Lê a conciliação, trava seus itens e depois a linha. Ordem fixa: itens antes de `matches`. */
async function lockMatch(dc: DecisionContext, id: string): Promise<{ match: MatchRow; refs: ItemRef[] }> {
  await findMatchRow(dc.db, dc.tenantId, id);
  const refs = await matchItemRefs(dc.db, dc.tenantId, [id]);
  await lockItems(dc.db, refs.map((ref) => ref.id));
  const match = await findMatchRow(dc.db, dc.tenantId, id, true);
  return { match, refs };
}

function invalidStatus(status: string, expected: string): AppError {
  return conflict(`Esta conciliação não está ${expected}.`, 'invalid_status', { status });
}

// ---------------------------------------------------------------------------
// Decisões sobre conciliações existentes
// ---------------------------------------------------------------------------

export interface AcceptOptions {
  note?: string;
  /** Aceite em lote: só sugestões não ambíguas e sem divergência. */
  bulk?: boolean;
  /** Os itens já foram travados por quem chamou (aceite em lote). */
  locked?: boolean;
}

export async function acceptMatch(dc: DecisionContext, id: string, options: AcceptOptions = {}): Promise<MatchView> {
  const { db, tenantId } = dc;
  let match: MatchRow;
  let refs: ItemRef[];
  if (options.locked) {
    match = await findMatchRow(db, tenantId, id, true);
    refs = await matchItemRefs(db, tenantId, [id]);
  } else {
    ({ match, refs } = await lockMatch(dc, id));
  }
  if (match.status !== 'suggested') {
    if (match.status === 'superseded' && (await anyActiveElsewhere(db, tenantId, refs, match.id))) throw alreadyReconciled();
    throw invalidStatus(match.status, 'aguardando revisão');
  }
  if (options.bulk && (match.ambiguous || match.divergence !== null || Number(match.difference_cents) !== 0)) {
    throw new AppError(
      422,
      'not_eligible',
      'Só sugestões não ambíguas e sem divergência podem ser aceitas em lote.',
    );
  }
  if (await anyActiveElsewhere(db, tenantId, refs, match.id)) throw alreadyReconciled();
  await guardReservation(db, () => setActive(db, tenantId, match.id, true));

  const needsApproval = approvalRequired(dc.approvals, questionFor(match));
  const status = needsApproval ? 'pending_approval' : 'confirmed';
  await db.query(
    `UPDATE matches
        SET status = $3, proposed_by = $4, proposed_at = now(), proposal_note = $5,
            decided_by = CASE WHEN $3 = 'confirmed' THEN $4::uuid END,
            decided_at = CASE WHEN $3 = 'confirmed' THEN now() END,
            decision_note = CASE WHEN $3 = 'confirmed' THEN $5 END
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, match.id, status, dc.userId, options.note ?? null],
  );
  await supersedeCompetitors(db, tenantId, match.id, refs);
  if (needsApproval) await notifyApprovers(dc, match.id, match.explanation ?? 'Sugestão aceita aguardando aprovação.');
  else await markItemsDecided(dc, match, refs);

  await dc.audit({
    action: 'reconciliation.match_accepted',
    entityType: 'match',
    entityId: match.id,
    summary: needsApproval ? 'Sugestão aceita e enviada para aprovação' : 'Sugestão aceita e conciliada',
    before: { status: match.status },
    after: { status, note: options.note ?? null },
    metadata: { type: match.match_type, ruleCode: match.rule_code, bulk: options.bulk ?? false, items: refs },
  });
  return getMatchView(db, tenantId, match.id);
}

export async function rejectMatch(dc: DecisionContext, id: string, reason: string): Promise<MatchView> {
  const { match, refs } = await lockMatch(dc, id);
  if (match.status !== 'suggested') throw invalidStatus(match.status, 'aguardando revisão');
  await dc.db.query(
    `UPDATE matches SET status = 'rejected', decided_by = $3, decided_at = now(), decision_note = $4
      WHERE tenant_id = $1 AND id = $2`,
    [dc.tenantId, match.id, dc.userId, reason],
  );
  await releaseDivergent(dc.db, dc.tenantId, refs);
  await dc.audit({
    action: 'reconciliation.match_rejected',
    entityType: 'match',
    entityId: match.id,
    summary: 'Sugestão rejeitada',
    before: { status: match.status },
    after: { status: 'rejected', reason },
    metadata: { type: match.match_type, ruleCode: match.rule_code, pairKey: match.pair_key },
  });
  return getMatchView(dc.db, dc.tenantId, match.id);
}

export async function approveMatch(dc: DecisionContext, id: string, note?: string): Promise<MatchView> {
  const { match, refs } = await lockMatch(dc, id);
  if (match.status !== 'pending_approval') throw invalidStatus(match.status, 'aguardando aprovação');
  // Quatro olhos vale pela configuração atual, mesmo que o módulo tenha sido desligado depois da proposta.
  if (dc.approvals.fourEyes && match.proposed_by !== null && match.proposed_by === dc.userId) {
    throw forbidden('Quem propôs a conciliação não pode aprová-la.', 'four_eyes');
  }
  await dc.db.query(
    `UPDATE matches SET status = 'confirmed', decided_by = $3, decided_at = now(), decision_note = $4
      WHERE tenant_id = $1 AND id = $2`,
    [dc.tenantId, match.id, dc.userId, note ?? null],
  );
  await markItemsDecided(dc, match, refs);
  await dc.audit({
    action: 'reconciliation.match_approved',
    entityType: 'match',
    entityId: match.id,
    summary: 'Conciliação aprovada',
    before: { status: match.status, proposedBy: match.proposed_by },
    after: { status: 'confirmed', note: note ?? null },
    metadata: { type: match.match_type, items: refs },
  });
  return getMatchView(dc.db, dc.tenantId, match.id);
}

export async function refuseMatch(dc: DecisionContext, id: string, reason: string): Promise<MatchView> {
  const { match, refs } = await lockMatch(dc, id);
  if (match.status !== 'pending_approval') throw invalidStatus(match.status, 'aguardando aprovação');
  await dc.db.query(
    `UPDATE matches SET status = 'rejected', decided_by = $3, decided_at = now(), decision_note = $4
      WHERE tenant_id = $1 AND id = $2`,
    [dc.tenantId, match.id, dc.userId, reason],
  );
  await setActive(dc.db, dc.tenantId, match.id, false);
  await releaseDivergent(dc.db, dc.tenantId, refs);
  await dc.audit({
    action: 'reconciliation.match_refused',
    entityType: 'match',
    entityId: match.id,
    summary: 'Aprovação recusada; itens liberados',
    before: { status: match.status, proposedBy: match.proposed_by },
    after: { status: 'rejected', reason },
    metadata: { type: match.match_type, items: refs },
  });
  return getMatchView(dc.db, dc.tenantId, match.id);
}

export async function undoMatch(dc: DecisionContext, id: string, reason: string): Promise<MatchView> {
  const { match, refs } = await lockMatch(dc, id);
  if (match.status !== 'confirmed') throw invalidStatus(match.status, 'vigente');
  await dc.db.query(
    `UPDATE matches SET status = 'undone', undone_by = $3, undone_at = now(), undo_reason = $4
      WHERE tenant_id = $1 AND id = $2`,
    [dc.tenantId, match.id, dc.userId, reason],
  );
  await setActive(dc.db, dc.tenantId, match.id, false);
  await setReconStatus(dc.db, dc.tenantId, refs, 'pending');
  await dc.audit({
    action: 'reconciliation.match_undone',
    entityType: 'match',
    entityId: match.id,
    summary: 'Conciliação desfeita; itens devolvidos a pendente',
    before: { status: match.status, autoConfirmed: match.auto_confirmed, decidedBy: match.decided_by },
    after: { status: 'undone', reason },
    metadata: { type: match.match_type, ruleCode: match.rule_code, items: refs },
  });
  return getMatchView(dc.db, dc.tenantId, match.id);
}

export type BulkResult =
  | { id: string; ok: true; status: string }
  | { id: string; ok: false; error: { code: string; message: string } };

export async function bulkAccept(dc: DecisionContext, ids: readonly string[]): Promise<BulkResult[]> {
  const unique = [...new Set(ids)];
  // Trava de uma vez todos os itens envolvidos, em ordem: lotes concorrentes não se bloqueiam em ciclo.
  const refs = await matchItemRefs(dc.db, dc.tenantId, unique);
  await lockItems(dc.db, refs.map((ref) => ref.id));
  const results: BulkResult[] = [];
  for (const id of unique) {
    await dc.db.query('SAVEPOINT recon_bulk');
    try {
      const view = await acceptMatch(dc, id, { bulk: true, locked: true });
      await dc.db.query('RELEASE SAVEPOINT recon_bulk');
      results.push({ id, ok: true, status: view.status });
    } catch (error) {
      await dc.db.query('ROLLBACK TO SAVEPOINT recon_bulk');
      if (!(error instanceof AppError)) throw error;
      results.push({ id, ok: false, error: { code: error.code, message: error.message } });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Decisões que criam conciliações
// ---------------------------------------------------------------------------

interface SourceItem {
  side: Side;
  id: string;
  bank_account_id: string | null;
  date: string;
  amount_cents: string;
  recon_status: string;
  active: boolean;
}

/** Itens pedidos, já travados. Algum inexistente (ou de outra empresa) responde 404. */
async function loadSourceItems(dc: DecisionContext, bankIds: readonly string[], ledgerIds: readonly string[]): Promise<SourceItem[]> {
  await lockItems(dc.db, [...bankIds, ...ledgerIds]);
  const result = await dc.db.query<SourceItem>(
    `SELECT 'bank'::text AS side, t.id, t.bank_account_id, t.posted_date AS date, t.amount_cents::text AS amount_cents,
            t.recon_status,
            EXISTS (SELECT 1 FROM match_items i WHERE i.tenant_id = t.tenant_id AND i.bank_transaction_id = t.id AND i.active) AS active
       FROM bank_transactions t WHERE t.tenant_id = $1 AND t.id = ANY ($2::uuid[])
     UNION ALL
     SELECT 'ledger'::text, t.id, t.bank_account_id, t.entry_date, t.amount_cents::text, t.recon_status,
            EXISTS (SELECT 1 FROM match_items i WHERE i.tenant_id = t.tenant_id AND i.ledger_entry_id = t.id AND i.active)
       FROM ledger_entries t WHERE t.tenant_id = $1 AND t.id = ANY ($3::uuid[])`,
    [dc.tenantId, bankIds, ledgerIds],
  );
  if (result.rows.length !== bankIds.length + ledgerIds.length) throw notFound('Item não encontrado.');
  return result.rows;
}

function assertFree(items: readonly SourceItem[]): void {
  if (items.some((item) => item.active || !OPEN_RECON_STATUSES.includes(item.recon_status))) throw alreadyReconciled();
}

interface NewMatch {
  type: 'manual' | 'ignored' | 'classification';
  bankAccountId: string | null;
  pairKey: string;
  bankIds: string[];
  ledgerIds: string[];
  question: ApprovalQuestion;
  differenceCents?: number;
  dateDiffDays?: number;
  divergence?: 'amount' | null;
  categoryId?: string | null;
  explanation: string;
  note: string | null;
}

async function createUserMatch(dc: DecisionContext, input: NewMatch): Promise<{ id: string; status: string }> {
  const needsApproval = approvalRequired(dc.approvals, input.question);
  const status = needsApproval ? 'pending_approval' : 'confirmed';
  const inserted = await dc.db.query<{ id: string }>(
    `INSERT INTO matches
       (tenant_id, bank_account_id, match_type, status, origin, difference_cents, date_diff_days, divergence,
        category_id, pair_key, explanation, proposed_by, proposed_at, proposal_note, decided_by, decided_at, decision_note)
     VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9, $10, $11, now(), $12,
             CASE WHEN $4 = 'confirmed' THEN $11::uuid END, CASE WHEN $4 = 'confirmed' THEN now() END,
             CASE WHEN $4 = 'confirmed' THEN $12 END)
     RETURNING id`,
    [
      dc.tenantId,
      input.bankAccountId,
      input.type,
      status,
      input.differenceCents ?? 0,
      input.dateDiffDays ?? 0,
      input.divergence ?? null,
      input.categoryId ?? null,
      input.pairKey,
      input.explanation,
      dc.userId,
      input.note,
    ],
  );
  const id = inserted.rows[0]!.id;
  await guardReservation(dc.db, () => insertMatchItems(dc.db, dc.tenantId, id, input.bankIds, input.ledgerIds, true));
  const refs: ItemRef[] = [
    ...input.bankIds.map((itemId) => ({ side: 'bank' as const, id: itemId })),
    ...input.ledgerIds.map((itemId) => ({ side: 'ledger' as const, id: itemId })),
  ];
  await supersedeCompetitors(dc.db, dc.tenantId, id, refs);
  if (needsApproval) await notifyApprovers(dc, id, input.explanation);
  else await markItemsDecided(dc, { match_type: input.type }, refs);
  return { id, status };
}

export interface ManualInput {
  bankTransactionIds: string[];
  ledgerEntryIds: string[];
  note?: string;
}

export async function manualMatch(dc: DecisionContext, input: ManualInput): Promise<MatchView> {
  const bankIds = [...new Set(input.bankTransactionIds)];
  const ledgerIds = [...new Set(input.ledgerEntryIds)];
  const items = await loadSourceItems(dc, bankIds, ledgerIds);
  assertFree(items);
  const amounts = items.map((item) => Number(item.amount_cents));
  if (!(amounts.every((amount) => amount > 0) || amounts.every((amount) => amount < 0))) {
    throw badRequest('Os itens de uma conciliação devem ter o mesmo sinal (todos entradas ou todos saídas).', 'sign_mismatch');
  }
  const sum = (side: Side) =>
    items.filter((item) => item.side === side).reduce((total, item) => total + Number(item.amount_cents), 0);
  const differenceCents = sum('bank') - sum('ledger');
  const note = input.note?.trim() || null;
  if (differenceCents !== 0 && !note) {
    throw badRequest('Conciliação com diferença de valor exige observação.', 'note_required', { differenceCents });
  }
  const times = items.map((item) => Date.parse(`${item.date}T00:00:00Z`));
  const dateDiffDays = Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000);
  const bankAccountId = items.find((item) => item.side === 'bank')?.bank_account_id ?? null;

  const created = await createUserMatch(dc, {
    type: 'manual',
    bankAccountId,
    pairKey: pairKey(bankIds, ledgerIds),
    bankIds,
    ledgerIds,
    question: { operation: 'manual', hasDifference: differenceCents !== 0, ambiguous: false, grouped: items.length > 2 },
    differenceCents,
    dateDiffDays,
    divergence: differenceCents !== 0 ? 'amount' : null,
    explanation: `Conciliação manual de ${bankIds.length} transação(ões) com ${ledgerIds.length} lançamento(s).`,
    note,
  });
  await dc.audit({
    action: 'reconciliation.match_manual',
    entityType: 'match',
    entityId: created.id,
    summary: created.status === 'confirmed' ? 'Conciliação manual registrada' : 'Conciliação manual enviada para aprovação',
    after: { status: created.status, bankTransactionIds: bankIds, ledgerEntryIds: ledgerIds, differenceCents, note },
  });
  return getMatchView(dc.db, dc.tenantId, created.id);
}

export async function ignoreItem(dc: DecisionContext, input: { side: Side; id: string; reason: string }): Promise<MatchView> {
  const bankIds = input.side === 'bank' ? [input.id] : [];
  const ledgerIds = input.side === 'ledger' ? [input.id] : [];
  const [item] = await loadSourceItems(dc, bankIds, ledgerIds);
  assertFree([item!]);
  const created = await createUserMatch(dc, {
    type: 'ignored',
    bankAccountId: item!.bank_account_id,
    // Prefixo próprio: recusar um "ignorar" não impede sugestões do motor para o mesmo item.
    pairKey: `ignore:${pairKey(bankIds, ledgerIds)}`,
    bankIds,
    ledgerIds,
    question: { operation: 'ignore', hasDifference: false, ambiguous: false },
    explanation: input.side === 'bank' ? 'Transação ignorada na conciliação.' : 'Lançamento ignorado na conciliação.',
    note: input.reason,
  });
  await dc.audit({
    action: 'reconciliation.item_ignored',
    entityType: 'match',
    entityId: created.id,
    summary: created.status === 'confirmed' ? 'Item ignorado' : 'Pedido para ignorar item enviado para aprovação',
    after: { status: created.status, side: input.side, itemId: input.id, reason: input.reason },
  });
  return getMatchView(dc.db, dc.tenantId, created.id);
}

export async function classifyItem(
  dc: DecisionContext,
  input: { bankTransactionId: string; categoryId: string; note?: string },
): Promise<MatchView> {
  const [item] = await loadSourceItems(dc, [input.bankTransactionId], []);
  const category = await dc.db.query<{ name: string }>(
    'SELECT name FROM categories WHERE tenant_id = $1 AND id = $2 AND active',
    [dc.tenantId, input.categoryId],
  );
  if (!category.rows[0]) throw badRequest('Categoria inexistente ou inativa.', 'invalid_category');
  assertFree([item!]);
  const note = input.note?.trim() || null;
  const created = await createUserMatch(dc, {
    type: 'classification',
    bankAccountId: item!.bank_account_id,
    pairKey: pairKey([input.bankTransactionId], []),
    bankIds: [input.bankTransactionId],
    ledgerIds: [],
    question: { operation: 'classification', hasDifference: false, ambiguous: false },
    categoryId: input.categoryId,
    explanation: `Classificada como ${category.rows[0].name}, sem lançamento correspondente.`,
    note,
  });
  await dc.audit({
    action: 'reconciliation.item_classified',
    entityType: 'match',
    entityId: created.id,
    summary: created.status === 'confirmed' ? 'Transação classificada' : 'Classificação enviada para aprovação',
    after: { status: created.status, bankTransactionId: input.bankTransactionId, categoryId: input.categoryId, note },
  });
  return getMatchView(dc.db, dc.tenantId, created.id);
}
