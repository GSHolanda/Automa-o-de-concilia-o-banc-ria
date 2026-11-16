import {
  addDays,
  pairKey,
  reconcile,
  reconRulesSchema,
  type ItemKind,
  type ProposedMatch,
  type ReconItem,
  type ReconRules,
  type TenantSettings,
} from '@concilia/core';
import type { Db } from '../../db/context';
import type { JobContext, JobHandler, JobRecord } from '../../jobs/types';
import type { Entitlements } from '../tenancy/entitlements';
import {
  insertMatchItems,
  matchItemRefs,
  releaseDivergent,
  setReconStatus,
  supersedeCompetitors,
  type ItemRef,
} from './decisions';

/**
 * Regras gravadas na execução: as da empresa, com agrupamento e transferências desligados
 * quando o módulo correspondente não está ativo.
 */
export function rulesSnapshot(settings: TenantSettings, entitlements: Entitlements): ReconRules {
  const rules = settings.reconciliation;
  return {
    ...rules,
    grouping: { ...rules.grouping, enabled: rules.grouping.enabled && entitlements.modules.includes('grouping') },
    transfers: { ...rules.transfers, enabled: rules.transfers.enabled && entitlements.modules.includes('transfers') },
  };
}

interface RunRecord {
  id: string;
  tenant_id: string;
  bank_account_id: string;
  period_start: string;
  period_end: string;
  status: string;
  rules_snapshot: unknown;
  started_by: string | null;
}

interface SourceRow {
  id: string;
  bank_account_id: string | null;
  date: string;
  amount_cents: string;
  description_norm: string;
  identifiers: string[];
  kind: ItemKind;
  category_id: string | null;
}

function toItem(side: 'bank' | 'ledger', row: SourceRow): ReconItem {
  return {
    id: row.id,
    side,
    accountId: row.bank_account_id,
    date: row.date,
    amountCents: Number(row.amount_cents),
    descriptionNorm: row.description_norm,
    identifiers: row.identifiers,
    kind: row.kind,
    categoryId: row.category_id,
  };
}

const FREE_BANK = `t.recon_status = 'pending'
  AND NOT EXISTS (SELECT 1 FROM match_items i WHERE i.tenant_id = t.tenant_id AND i.bank_transaction_id = t.id AND i.active)`;
const FREE_LEDGER = `t.recon_status = 'pending'
  AND NOT EXISTS (SELECT 1 FROM match_items i WHERE i.tenant_id = t.tenant_id AND i.ledger_entry_id = t.id AND i.active)`;
const BANK_COLUMNS = `t.id, t.bank_account_id, t.posted_date AS date, t.amount_cents::text AS amount_cents, t.description_norm,
  t.identifiers, t.kind, t.category_id`;

async function loadInput(db: Db, run: RunRecord, rules: ReconRules) {
  const tenantId = run.tenant_id;
  const bank = await db.query<SourceRow>(
    `SELECT ${BANK_COLUMNS} FROM bank_transactions t
      WHERE t.tenant_id = $1 AND t.bank_account_id = $2 AND t.posted_date BETWEEN $3 AND $4 AND ${FREE_BANK}`,
    [tenantId, run.bank_account_id, run.period_start, run.period_end],
  );
  const window = Math.max(rules.dateToleranceDays, rules.identifierMaxDateDiffDays);
  const ledger = await db.query<SourceRow>(
    `SELECT t.id, t.bank_account_id, t.entry_date AS date, t.amount_cents::text AS amount_cents, t.description_norm,
            t.identifiers, t.kind, NULL::uuid AS category_id
       FROM ledger_entries t
      WHERE t.tenant_id = $1 AND (t.bank_account_id = $2 OR t.bank_account_id IS NULL)
        AND t.entry_date BETWEEN $3 AND $4 AND ${FREE_LEDGER}`,
    [tenantId, run.bank_account_id, addDays(run.period_start, -window), addDays(run.period_end, window)],
  );
  const other = rules.transfers.enabled
    ? await db.query<SourceRow>(
        `SELECT ${BANK_COLUMNS} FROM bank_transactions t
          WHERE t.tenant_id = $1 AND t.bank_account_id <> $2 AND t.kind = 'internal_transfer'
            AND t.posted_date BETWEEN $3 AND $4 AND ${FREE_BANK}`,
        [
          tenantId,
          run.bank_account_id,
          addDays(run.period_start, -rules.transfers.dateToleranceDays),
          addDays(run.period_end, rules.transfers.dateToleranceDays),
        ],
      )
    : { rows: [] as SourceRow[] };
  return {
    bank: bank.rows.map((row) => toItem('bank', row)),
    ledger: ledger.rows.map((row) => toItem('ledger', row)),
    otherAccountsBank: other.rows.map((row) => toItem('bank', row)),
  };
}

/**
 * Pares que o motor não deve propor de novo (rejeitados ou desfeitos por pessoas) e pares que já têm
 * sugestão ou proposta aberta (não se duplicam).
 */
async function knownPairs(db: Db, tenantId: string, bankIds: string[], ledgerIds: string[]) {
  const result = await db.query<{ pair_key: string; status: string }>(
    `SELECT DISTINCT m.pair_key, m.status FROM matches m
      WHERE m.tenant_id = $1 AND m.status IN ('rejected', 'undone', 'suggested', 'pending_approval')
        AND EXISTS (
          SELECT 1 FROM match_items i
           WHERE i.tenant_id = m.tenant_id AND i.match_id = m.id
             AND (i.bank_transaction_id = ANY ($2::uuid[]) OR i.ledger_entry_id = ANY ($3::uuid[])))`,
    [tenantId, bankIds, ledgerIds],
  );
  const rejected = new Set<string>();
  const open = new Set<string>();
  for (const row of result.rows) {
    if (row.status === 'rejected' || row.status === 'undone') rejected.add(row.pair_key);
    else open.add(row.pair_key);
  }
  return { rejected, open };
}

function refsOf(match: ProposedMatch): ItemRef[] {
  return [
    ...match.bankIds.map((id) => ({ side: 'bank' as const, id })),
    ...match.ledgerIds.map((id) => ({ side: 'ledger' as const, id })),
  ];
}

/** Grava um resultado do motor. Devolve falso se um item foi reservado por decisão concorrente. */
async function saveProposal(db: Db, run: RunRecord, engineVersion: string, match: ProposedMatch): Promise<boolean> {
  const tenantId = run.tenant_id;
  const auto = match.decision === 'auto';
  await db.query('SAVEPOINT recon_proposal');
  let matchId: string;
  try {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO matches
         (tenant_id, run_id, bank_account_id, match_type, status, origin, auto_confirmed, rule_code, engine_version,
          confidence, breakdown, explanation, difference_cents, date_diff_days, divergence, ambiguous, category_id,
          pair_key, proposed_at, decided_at)
       VALUES ($1, $2, $3, $4, $5, 'engine', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now(),
               CASE WHEN $6 THEN now() END)
       RETURNING id`,
      [
        tenantId,
        run.id,
        run.bank_account_id,
        match.type,
        auto ? 'confirmed' : 'suggested',
        auto,
        match.ruleCode,
        engineVersion,
        match.confidence,
        JSON.stringify(match.breakdown),
        match.explanation,
        match.differenceCents,
        match.dateDiffDays,
        match.divergence,
        match.ambiguous,
        match.categoryId,
        pairKey(match.bankIds, match.ledgerIds),
      ],
    );
    matchId = inserted.rows[0]!.id;
    await insertMatchItems(db, tenantId, matchId, match.bankIds, match.ledgerIds, auto);
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT recon_proposal');
    if ((error as { code?: string })?.code === '23505') return false;
    throw error;
  }
  await db.query('RELEASE SAVEPOINT recon_proposal');
  if (auto) {
    await setReconStatus(db, tenantId, refsOf(match), 'reconciled');
    // Sugestão aberta de outra execução (ex.: transferência vista pela outra conta) deixa de valer.
    await supersedeCompetitors(db, tenantId, matchId, refsOf(match));
  } else if (match.divergence) await setReconStatus(db, tenantId, refsOf(match), 'divergent', ['pending']);
  return true;
}

async function executeRun(context: JobContext): Promise<unknown> {
  const { db, job, tenantId } = context;
  const runId = typeof job.payload.runId === 'string' ? job.payload.runId : null;
  if (!runId) throw new Error('Trabalho de conciliação sem execução');
  const found = await db.query<RunRecord>(
    `SELECT id, tenant_id, bank_account_id, period_start, period_end, status, rules_snapshot, started_by
       FROM reconciliation_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, runId],
  );
  const run = found.rows[0];
  if (!run) throw new Error('Execução de conciliação não encontrada');
  // Execução já concluída (trabalho repetido): nada a fazer.
  if (run.status === 'completed' || run.status === 'failed') return { runId, status: run.status, skipped: true };

  // Uma execução por conta de cada vez.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`recon:${tenantId}:${run.bank_account_id}`]);
  const rules = reconRulesSchema.parse(run.rules_snapshot);

  // Sugestões anteriores do motor para o período são substituídas; decisões humanas ficam intactas.
  const superseded = await db.query<{ id: string }>(
    `UPDATE matches m SET status = 'superseded'
      WHERE m.tenant_id = $1 AND m.bank_account_id = $2 AND m.status = 'suggested' AND m.origin = 'engine'
        AND m.divergence IS DISTINCT FROM 'duplicate'
        AND EXISTS (
          SELECT 1 FROM match_items i
            JOIN bank_transactions b ON b.tenant_id = i.tenant_id AND b.id = i.bank_transaction_id
           WHERE i.tenant_id = m.tenant_id AND i.match_id = m.id
             AND b.bank_account_id = $2 AND b.posted_date BETWEEN $3 AND $4)
      RETURNING m.id`,
    [tenantId, run.bank_account_id, run.period_start, run.period_end],
  );
  await releaseDivergent(db, tenantId, await matchItemRefs(db, tenantId, superseded.rows.map((row) => row.id)));

  const input = await loadInput(db, run, rules);
  const pairs = await knownPairs(
    db,
    tenantId,
    [...input.bank, ...input.otherAccountsBank].map((item) => item.id),
    input.ledger.map((item) => item.id),
  );
  const output = reconcile({ ...input, rejectedPairs: pairs.rejected, rules });

  let saved = 0;
  let discarded = 0;
  let alreadyOpen = 0;
  for (const match of output.matches) {
    if (match.decision === 'suggest' && pairs.open.has(pairKey(match.bankIds, match.ledgerIds))) {
      alreadyOpen += 1;
      continue;
    }
    if (await saveProposal(db, run, output.engineVersion, match)) saved += 1;
    else discarded += 1;
  }

  const stats = {
    ...output.stats,
    otherAccountsBankItems: input.otherAccountsBank.length,
    saved,
    discarded,
    alreadyOpen,
    superseded: superseded.rows.length,
  };
  await db.query(
    `UPDATE reconciliation_runs
        SET status = 'completed', engine_version = $3, stats = $4, error = NULL, finished_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, run.id, output.engineVersion, JSON.stringify(stats)],
  );
  await context.audit({
    action: 'reconciliation.run_completed',
    entityType: 'reconciliation_run',
    entityId: run.id,
    summary:
      `Conciliação de ${run.period_start} a ${run.period_end}: ${output.stats.autoMatched} automática(s), ` +
      `${output.stats.suggested} sugestão(ões), ${output.stats.divergences} divergência(s)`,
    after: { status: 'completed', stats },
    metadata: { jobId: job.id, engineVersion: output.engineVersion, startedBy: run.started_by },
  });
  return { runId: run.id, status: 'completed', stats };
}

function runIdOf(job: JobRecord): string | null {
  return typeof job.payload.runId === 'string' ? job.payload.runId : null;
}

export const reconciliationRunHandler: JobHandler = {
  run: executeRun,
  onDead: async (db, job, error) => {
    const runId = runIdOf(job);
    if (!runId) return;
    await db.query(
      `UPDATE reconciliation_runs SET status = 'failed', error = $3, finished_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'running')`,
      [job.tenant_id, runId, `A execução falhou após ${job.attempts} tentativa(s): ${error.slice(0, 500)}`],
    );
  },
  onRetry: async (db, job) => {
    const runId = runIdOf(job);
    if (!runId) return;
    await db.query(
      `UPDATE reconciliation_runs SET status = 'queued', error = NULL, finished_at = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = 'failed'`,
      [job.tenant_id, runId],
    );
  },
};
