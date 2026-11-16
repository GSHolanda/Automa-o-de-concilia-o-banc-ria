import { z } from 'zod';
import type { Db } from '../../db/context';
import { route, type RouteDefinition } from '../../http/route';

/** Situações exibidas no painel; "aguardando aprovação" é separada de pendente. */
const STATUSES = ['pending', 'divergent', 'reconciled', 'ignored', 'awaitingApproval'] as const;
type DashStatus = (typeof STATUSES)[number];

interface Totals {
  count: number;
  amountCents: number;
  creditsCents: number;
  debitsCents: number;
}
type Summary = Record<DashStatus | 'total', Totals>;

const zero = (): Totals => ({ count: 0, amountCents: 0, creditsCents: 0, debitsCents: 0 });
const emptySummary = (): Summary => ({
  pending: zero(),
  divergent: zero(),
  reconciled: zero(),
  ignored: zero(),
  awaitingApproval: zero(),
  total: zero(),
});

interface GroupRow {
  bank_account_id: string | null;
  status: string;
  count: number;
  amount: string;
  credits: string;
  debits: string;
}

function addTo(summary: Summary, row: GroupRow): void {
  const key: DashStatus = row.status === 'awaiting_approval' ? 'awaitingApproval' : (row.status as DashStatus);
  for (const target of [summary[key], summary.total]) {
    target.count += row.count;
    target.amountCents += Number(row.amount);
    target.creditsCents += Number(row.credits);
    target.debitsCents += Number(row.debits);
  }
}

interface Filters {
  bankAccountId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/** Contagem e soma por conta e situação de um lado. */
async function grouped(db: Db, tenantId: string, side: 'bank' | 'ledger', filters: Filters): Promise<GroupRow[]> {
  const table = side === 'bank' ? 'bank_transactions' : 'ledger_entries';
  const column = side === 'bank' ? 'bank_transaction_id' : 'ledger_entry_id';
  const date = side === 'bank' ? 't.posted_date' : 't.entry_date';
  const values: unknown[] = [tenantId];
  const where = ['t.tenant_id = $1'];
  if (filters.bankAccountId) {
    values.push(filters.bankAccountId);
    where.push(`t.bank_account_id = $${values.length}`);
  }
  if (filters.dateFrom) {
    values.push(filters.dateFrom);
    where.push(`${date} >= $${values.length}`);
  }
  if (filters.dateTo) {
    values.push(filters.dateTo);
    where.push(`${date} <= $${values.length}`);
  }
  const result = await db.query<GroupRow>(
    `SELECT t.bank_account_id,
            CASE WHEN EXISTS (
              SELECT 1 FROM match_items i JOIN matches m ON m.tenant_id = i.tenant_id AND m.id = i.match_id
               WHERE i.tenant_id = t.tenant_id AND i.${column} = t.id AND i.active AND m.status = 'pending_approval'
            ) THEN 'awaiting_approval' ELSE t.recon_status END AS status,
            count(*)::int AS count,
            coalesce(sum(t.amount_cents), 0)::text AS amount,
            coalesce(sum(t.amount_cents) FILTER (WHERE t.amount_cents > 0), 0)::text AS credits,
            coalesce(sum(t.amount_cents) FILTER (WHERE t.amount_cents < 0), 0)::text AS debits
       FROM ${table} t
      WHERE ${where.join(' AND ')}
      GROUP BY 1, 2`,
    values,
  );
  return result.rows;
}

const query = z
  .object({ bankAccountId: z.uuid().optional(), dateFrom: z.iso.date().optional(), dateTo: z.iso.date().optional() })
  .refine((value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo, {
    message: 'A data inicial deve ser anterior ou igual à final.',
    path: ['dateTo'],
  });

export const routes: RouteDefinition[] = [
  route({
    tags: ['painel'],
    auth: 'session',
    permission: 'dashboard.view',
    method: 'GET',
    url: '/dashboard',
    summary: 'Totais por situação, sugestões abertas, aprovações pendentes, por conta e últimas atividades',
    query,
    handler: async ({ db, tenantId, query: filters }) => {
      const accounts = await db.query<{ id: string; name: string; active: boolean }>(
        `SELECT id, name, active FROM bank_accounts WHERE tenant_id = $1${filters.bankAccountId ? ' AND id = $2' : ''}
          ORDER BY name, id`,
        filters.bankAccountId ? [tenantId, filters.bankAccountId] : [tenantId],
      );
      // Consultas em sequência: a transação usa uma única conexão.
      const bankRows = await grouped(db, tenantId, 'bank', filters);
      const ledgerRows = await grouped(db, tenantId, 'ledger', filters);
      const bank = emptySummary();
      const ledger = emptySummary();
      const ledgerWithoutAccount = emptySummary();
      const perAccount = new Map(accounts.rows.map((row) => [row.id, { bank: emptySummary(), ledger: emptySummary() }]));
      for (const row of bankRows) {
        addTo(bank, row);
        const entry = row.bank_account_id ? perAccount.get(row.bank_account_id) : undefined;
        if (entry) addTo(entry.bank, row);
      }
      for (const row of ledgerRows) {
        addTo(ledger, row);
        const entry = row.bank_account_id ? perAccount.get(row.bank_account_id) : undefined;
        if (entry) addTo(entry.ledger, row);
        else if (!row.bank_account_id) addTo(ledgerWithoutAccount, row);
      }

      // Sugestões e aprovações com ao menos um item dentro dos filtros.
      const values: unknown[] = [tenantId];
      const itemWhere: string[] = [];
      if (filters.bankAccountId) {
        values.push(filters.bankAccountId);
        itemWhere.push(`coalesce(b.bank_account_id, l.bank_account_id) = $${values.length}`);
      }
      if (filters.dateFrom) {
        values.push(filters.dateFrom);
        itemWhere.push(`coalesce(b.posted_date, l.entry_date) >= $${values.length}`);
      }
      if (filters.dateTo) {
        values.push(filters.dateTo);
        itemWhere.push(`coalesce(b.posted_date, l.entry_date) <= $${values.length}`);
      }
      const open = await db.query<{ suggested: number; pending_approval: number }>(
        `SELECT count(*) FILTER (WHERE m.status = 'suggested')::int AS suggested,
                count(*) FILTER (WHERE m.status = 'pending_approval')::int AS pending_approval
           FROM matches m
          WHERE m.tenant_id = $1 AND m.status IN ('suggested', 'pending_approval')
            ${
              itemWhere.length === 0
                ? ''
                : `AND EXISTS (
                     SELECT 1 FROM match_items i
                       LEFT JOIN bank_transactions b ON b.tenant_id = i.tenant_id AND b.id = i.bank_transaction_id
                       LEFT JOIN ledger_entries l ON l.tenant_id = i.tenant_id AND l.id = i.ledger_entry_id
                      WHERE i.tenant_id = m.tenant_id AND i.match_id = m.id AND ${itemWhere.join(' AND ')})`
            }`,
        values,
      );

      // Taxa de conciliação automática: transações conciliadas por regra automática / transações conciliadas.
      const autoValues: unknown[] = [tenantId];
      const autoWhere = ["t.tenant_id = $1", "t.recon_status = 'reconciled'"];
      if (filters.bankAccountId) {
        autoValues.push(filters.bankAccountId);
        autoWhere.push(`t.bank_account_id = $${autoValues.length}`);
      }
      if (filters.dateFrom) {
        autoValues.push(filters.dateFrom);
        autoWhere.push(`t.posted_date >= $${autoValues.length}`);
      }
      if (filters.dateTo) {
        autoValues.push(filters.dateTo);
        autoWhere.push(`t.posted_date <= $${autoValues.length}`);
      }
      const auto = await db.query<{ reconciled: number; auto: number }>(
        `SELECT count(*)::int AS reconciled, count(*) FILTER (WHERE m.auto_confirmed)::int AS auto
           FROM bank_transactions t
           LEFT JOIN match_items i ON i.tenant_id = t.tenant_id AND i.bank_transaction_id = t.id AND i.active
           LEFT JOIN matches m ON m.tenant_id = i.tenant_id AND m.id = i.match_id AND m.status = 'confirmed'
          WHERE ${autoWhere.join(' AND ')}`,
        autoValues,
      );
      const reconciled = auto.rows[0]?.reconciled ?? 0;
      const autoCount = auto.rows[0]?.auto ?? 0;

      const accountFilter = filters.bankAccountId ? ' AND bank_account_id = $2' : '';
      const accountValues = filters.bankAccountId ? [tenantId, filters.bankAccountId] : [tenantId];
      const lastImport = await db.query<{
        id: string;
        source_kind: string;
        bank_account_id: string | null;
        file_name: string;
        status: string;
        stats: unknown;
        created_at: Date;
        processed_at: Date | null;
      }>(
        `SELECT id, source_kind, bank_account_id, file_name, status, stats, created_at, processed_at
           FROM import_batches
          WHERE tenant_id = $1 AND status NOT IN ('uploaded', 'canceled')${accountFilter}
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        accountValues,
      );
      const lastRun = await db.query<{
        id: string;
        bank_account_id: string;
        period_start: string;
        period_end: string;
        status: string;
        stats: unknown;
        created_at: Date;
        finished_at: Date | null;
      }>(
        `SELECT id, bank_account_id, period_start, period_end, status, stats, created_at, finished_at
           FROM reconciliation_runs WHERE tenant_id = $1${accountFilter}
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        accountValues,
      );
      const importRow = lastImport.rows[0];
      const runRow = lastRun.rows[0];

      return {
        filters: {
          bankAccountId: filters.bankAccountId ?? null,
          dateFrom: filters.dateFrom ?? null,
          dateTo: filters.dateTo ?? null,
        },
        bank,
        ledger,
        ledgerWithoutAccount,
        openSuggestions: open.rows[0]?.suggested ?? 0,
        pendingApprovals: open.rows[0]?.pending_approval ?? 0,
        byAccount: accounts.rows.map((account) => ({
          bankAccountId: account.id,
          name: account.name,
          active: account.active,
          ...(perAccount.get(account.id) ?? { bank: emptySummary(), ledger: emptySummary() }),
        })),
        lastImport: importRow
          ? {
              id: importRow.id,
              sourceKind: importRow.source_kind,
              bankAccountId: importRow.bank_account_id,
              fileName: importRow.file_name,
              status: importRow.status,
              stats: importRow.stats,
              createdAt: importRow.created_at.toISOString(),
              processedAt: importRow.processed_at?.toISOString() ?? null,
            }
          : null,
        lastRun: runRow
          ? {
              id: runRow.id,
              bankAccountId: runRow.bank_account_id,
              periodStart: runRow.period_start,
              periodEnd: runRow.period_end,
              status: runRow.status,
              stats: runRow.stats,
              createdAt: runRow.created_at.toISOString(),
              finishedAt: runRow.finished_at?.toISOString() ?? null,
            }
          : null,
        autoReconciliation: {
          reconciled,
          auto: autoCount,
          rate: reconciled === 0 ? null : Math.round((autoCount / reconciled) * 10_000) / 10_000,
        },
      };
    },
  }),
];
