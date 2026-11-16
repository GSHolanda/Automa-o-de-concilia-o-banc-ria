import { ITEM_KIND_LABELS, RULE_LABELS, type RuleCode } from '@concilia/core';
import { z } from 'zod';
import type { Db } from '../../db/context';
import { badRequest, notFound, unprocessable } from '../../http/errors';
import { queryReconItems, type ItemStatus, type ReconItemFilters, type ReconItemView } from '../reconciliation/queries';
import type { Cell, Column, Report, Section } from './model';

/** Limite de linhas por exportação. Objeto mutável apenas para que os testes possam reduzi-lo. */
export const exportLimits = { maxRows: 50_000 };

const PAGE_SIZE = 1000;

export const STATUS_LABELS: Record<ItemStatus, string> = {
  pending: 'Pendente',
  divergent: 'Divergente',
  reconciled: 'Conciliado',
  ignored: 'Ignorado',
  awaiting_approval: 'Aguardando aprovação',
};

const SIDE_LABELS = { bank: 'Extrato', ledger: 'Lançamento' } as const;

interface ColumnDef extends Column {
  value: (item: ReconItemView) => Cell;
}

/** Colunas disponíveis para os modelos de itens. */
const ITEM_COLUMNS: Record<string, ColumnDef> = {
  date: { key: 'date', label: 'Data', kind: 'date', width: 9, value: (i) => i.date },
  description: { key: 'description', label: 'Descrição', kind: 'text', width: 30, value: (i) => i.description },
  document: { key: 'document', label: 'Documento', kind: 'text', width: 12, value: (i) => i.document },
  amount: { key: 'amount', label: 'Valor', kind: 'money', width: 12, value: (i) => i.amountCents },
  status: { key: 'status', label: 'Situação', kind: 'text', width: 14, value: (i) => STATUS_LABELS[i.status] },
  kind: { key: 'kind', label: 'Tipo', kind: 'text', width: 14, value: (i) => ITEM_KIND_LABELS[i.kind] },
  account: { key: 'account', label: 'Conta', kind: 'text', width: 14, value: (i) => i.bankAccountName },
  side: { key: 'side', label: 'Origem', kind: 'text', width: 10, value: (i) => SIDE_LABELS[i.side] },
  category: { key: 'category', label: 'Categoria', kind: 'text', width: 16, value: (i) => i.categoryName },
  reference: { key: 'reference', label: 'Referência', kind: 'text', width: 14, value: (i) => i.reference },
  counterparty: { key: 'counterparty', label: 'Contraparte', kind: 'text', width: 18, value: (i) => i.counterparty },
  externalId: { key: 'externalId', label: 'Id externo', kind: 'text', width: 14, value: (i) => i.externalId },
};
const DEFAULT_ITEM_COLUMNS = ['date', 'description', 'document', 'amount', 'status', 'kind', 'account'];

// ---------------------------------------------------------------------------
// Modelos de relatório
// ---------------------------------------------------------------------------

const templateConfigSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  columns: z.array(z.string()).optional(),
  footer: z.string().max(500).optional(),
  includePending: z.boolean().optional(),
  includeDivergent: z.boolean().optional(),
});
export type TemplateConfig = z.infer<typeof templateConfigSchema>;

/** Modelo pedido (404 se for de outra empresa ou não existir; 400 se o tipo não serve) ou o padrão do tipo. */
export async function loadTemplate(
  db: Db,
  tenantId: string,
  kind: 'items' | 'summary',
  templateId: string | undefined,
): Promise<TemplateConfig> {
  const result = templateId
    ? await db.query<{ kind: string; config: unknown }>(
        'SELECT kind, config FROM report_templates WHERE tenant_id = $1 AND id = $2',
        [tenantId, templateId],
      )
    : await db.query<{ kind: string; config: unknown }>(
        `SELECT kind, config FROM report_templates WHERE tenant_id = $1 AND kind = $2
          ORDER BY is_default DESC, name LIMIT 1`,
        [tenantId, kind],
      );
  const row = result.rows[0];
  if (templateId) {
    if (!row) throw notFound('Modelo de relatório não encontrado.');
    if (row.kind !== kind) throw badRequest(`Este modelo é do tipo "${row.kind}", não serve para este relatório.`, 'invalid_template');
  }
  if (!row) return {};
  const parsed = templateConfigSchema.safeParse(row.config);
  return parsed.success ? parsed.data : {};
}

// ---------------------------------------------------------------------------
// Cabeçalho comum
// ---------------------------------------------------------------------------

export interface ReportMeta {
  company: string;
  generatedBy: string;
  generatedAt: Date;
}

export async function loadCompanyName(db: Db, tenantId: string): Promise<string> {
  const result = await db.query<{ trade_name: string }>('SELECT trade_name FROM tenants WHERE id = $1', [tenantId]);
  return result.rows[0]?.trade_name ?? '';
}

export function periodLabel(from?: string, to?: string): string {
  const format = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  if (from && to) return `Período: ${format(from)} a ${format(to)}`;
  if (from) return `Período: a partir de ${format(from)}`;
  if (to) return `Período: até ${format(to)}`;
  return 'Período: todas as datas';
}

/** Descrição curta dos filtros aplicados, para o cabeçalho do relatório. */
function filterLines(filters: ReconItemFilters, accountName: string | null): string[] {
  const parts: string[] = [];
  if (filters.side) parts.push(`origem: ${SIDE_LABELS[filters.side]}`);
  if (accountName) parts.push(`conta: ${accountName}`);
  if (filters.status) parts.push(`situação: ${STATUS_LABELS[filters.status]}`);
  if (filters.kind) parts.push(`tipo: ${ITEM_KIND_LABELS[filters.kind]}`);
  if (filters.direction) parts.push(filters.direction === 'credit' ? 'somente entradas' : 'somente saídas');
  if (filters.q) parts.push(`busca: ${filters.q}`);
  return parts.length > 0 ? [`Filtros: ${parts.join('; ')}`] : [];
}

// ---------------------------------------------------------------------------
// Itens
// ---------------------------------------------------------------------------

/** Todos os itens do filtro, paginando internamente. Acima do limite de linhas: 422. */
export async function fetchAllItems(db: Db, tenantId: string, filters: ReconItemFilters): Promise<ReconItemView[]> {
  const all: ReconItemView[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryReconItems(db, tenantId, filters, { limit: PAGE_SIZE, cursor });
    all.push(...page.items);
    if (all.length > exportLimits.maxRows) throw tooLarge();
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

export function tooLarge() {
  return unprocessable(
    `A exportação passa do limite de ${exportLimits.maxRows.toLocaleString('pt-BR')} linhas. Restrinja os filtros e tente de novo.`,
    'export_too_large',
    { maxRows: exportLimits.maxRows },
  );
}

function itemTotals(items: { amountCents: number }[]) {
  let credits = 0;
  let debits = 0;
  for (const item of items) {
    if (item.amountCents >= 0) credits += item.amountCents;
    else debits += item.amountCents;
  }
  return [
    { label: 'Total de itens', value: items.length, kind: 'int' as const },
    { label: 'Entradas', value: credits, kind: 'money' as const },
    { label: 'Saídas', value: debits, kind: 'money' as const },
    { label: 'Saldo', value: credits + debits, kind: 'money' as const },
  ];
}

export async function buildItemsReport(
  db: Db,
  tenantId: string,
  filters: ReconItemFilters,
  templateId: string | undefined,
  meta: ReportMeta,
): Promise<{ report: Report; rows: number }> {
  const template = await loadTemplate(db, tenantId, 'items', templateId);
  const items = await fetchAllItems(db, tenantId, filters);
  const keys = (template.columns ?? []).filter((key) => key in ITEM_COLUMNS);
  const defs = (keys.length > 0 ? keys : DEFAULT_ITEM_COLUMNS).map((key) => ITEM_COLUMNS[key]!);
  const accountName = filters.bankAccountId ? await accountNameOf(db, tenantId, filters.bankAccountId) : null;
  const section: Section = {
    title: 'Itens',
    columns: defs.map(({ value: _value, ...column }) => column),
    rows: items.map((item) => defs.map((def) => def.value(item))),
    totals: itemTotals(items),
  };
  return {
    rows: items.length,
    report: {
      ...meta,
      title: template.title ?? 'Itens de conciliação',
      subtitle: [periodLabel(filters.dateFrom, filters.dateTo), ...filterLines(filters, accountName)],
      footer: template.footer ?? '',
      sections: [section],
    },
  };
}

async function accountNameOf(db: Db, tenantId: string, id: string): Promise<string | null> {
  const result = await db.query<{ name: string }>('SELECT name FROM bank_accounts WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  return result.rows[0]?.name ?? null;
}

// ---------------------------------------------------------------------------
// Resumo
// ---------------------------------------------------------------------------

export interface SummaryInput {
  bankAccountId: string;
  dateFrom: string;
  dateTo: string;
}

const SUMMARY_STATUSES: ItemStatus[] = ['pending', 'divergent', 'awaiting_approval', 'reconciled', 'ignored'];

const LIST_COLUMNS: Column[] = [
  ITEM_COLUMNS.side!,
  ITEM_COLUMNS.date!,
  ITEM_COLUMNS.description!,
  ITEM_COLUMNS.document!,
  ITEM_COLUMNS.amount!,
].map(({ key, label, kind, width }) => ({ key, label, kind, width }));

export async function buildSummaryReport(
  db: Db,
  tenantId: string,
  input: SummaryInput,
  templateId: string | undefined,
  meta: ReportMeta,
): Promise<{ report: Report; rows: number }> {
  const accountName = await accountNameOf(db, tenantId, input.bankAccountId);
  if (accountName === null) throw notFound('Conta bancária não encontrada.');
  const template = await loadTemplate(db, tenantId, 'summary', templateId);
  const items = await fetchAllItems(db, tenantId, input);

  const sum = (side: 'bank' | 'ledger', status?: ItemStatus) => {
    const selected = items.filter((item) => item.side === side && (status === undefined || item.status === status));
    return [selected.length, selected.reduce((acc, item) => acc + item.amountCents, 0)] as const;
  };
  const statusRows: Cell[][] = SUMMARY_STATUSES.map((status) => [
    STATUS_LABELS[status],
    ...sum('bank', status),
    ...sum('ledger', status),
  ]);
  statusRows.push(['Total', ...sum('bank'), ...sum('ledger')]);

  const sections: Section[] = [
    {
      title: 'Resumo',
      columns: [
        { key: 'status', label: 'Situação', kind: 'text', width: 20 },
        { key: 'bankCount', label: 'Extrato (itens)', kind: 'int', width: 12 },
        { key: 'bankAmount', label: 'Extrato (valor)', kind: 'money', width: 16 },
        { key: 'ledgerCount', label: 'Lançamentos (itens)', kind: 'int', width: 14 },
        { key: 'ledgerAmount', label: 'Lançamentos (valor)', kind: 'money', width: 16 },
      ],
      rows: statusRows,
      totals: [],
    },
  ];
  const listOf = (status: ItemStatus, title: string): Section => {
    const selected = items.filter((item) => item.status === status);
    return {
      title,
      columns: LIST_COLUMNS,
      rows: selected.map((item) => [SIDE_LABELS[item.side], item.date, item.description, item.document, item.amountCents]),
      totals: itemTotals(selected).slice(0, 1),
    };
  };
  if (template.includePending !== false) sections.push(listOf('pending', 'Pendentes'));
  if (template.includeDivergent !== false) sections.push(listOf('divergent', 'Divergentes'));
  sections.push(await rulesSection(db, tenantId, input));

  return {
    rows: items.length,
    report: {
      ...meta,
      title: template.title ?? 'Relatório de conciliação bancária',
      subtitle: [`Conta: ${accountName}`, periodLabel(input.dateFrom, input.dateTo)],
      footer: template.footer ?? '',
      sections,
    },
  };
}

/** Conciliações vigentes da conta, agrupadas pela regra que as produziu, com itens do extrato no período. */
async function rulesSection(db: Db, tenantId: string, input: SummaryInput): Promise<Section> {
  const result = await db.query<{ rule_code: string | null; match_type: string; total: number }>(
    `SELECT m.rule_code, m.match_type, count(*)::int AS total
       FROM matches m
      WHERE m.tenant_id = $1 AND m.status = 'confirmed' AND m.bank_account_id = $2
        AND EXISTS (
          SELECT 1 FROM match_items i
            JOIN bank_transactions b ON b.tenant_id = i.tenant_id AND b.id = i.bank_transaction_id
           WHERE i.tenant_id = m.tenant_id AND i.match_id = m.id AND b.posted_date BETWEEN $3::date AND $4::date)
      GROUP BY m.rule_code, m.match_type
      ORDER BY count(*) DESC, m.rule_code NULLS LAST, m.match_type`,
    [tenantId, input.bankAccountId, input.dateFrom, input.dateTo],
  );
  const manualLabels: Record<string, string> = {
    manual: 'Conciliação manual',
    ignored: 'Item ignorado',
    classification: 'Classificação manual',
  };
  const label = (row: { rule_code: string | null; match_type: string }) =>
    (row.rule_code && RULE_LABELS[row.rule_code as RuleCode]) || manualLabels[row.match_type] || row.match_type;
  return {
    title: 'Regras',
    columns: [
      { key: 'rule', label: 'Regra', kind: 'text', width: 30 },
      { key: 'total', label: 'Conciliações', kind: 'int', width: 12 },
    ],
    rows: result.rows.map((row) => [label(row), row.total]),
    totals: [{ label: 'Total de conciliações', value: result.rows.reduce((acc, row) => acc + row.total, 0), kind: 'int' }],
  };
}

// ---------------------------------------------------------------------------
// Lançamentos pendentes no ERP
// ---------------------------------------------------------------------------

export interface PendingEntriesInput {
  bankAccountId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/** Classificações confirmadas sem lançamento correspondente: o que ainda precisa ser lançado no sistema financeiro. */
export async function buildPendingEntriesReport(
  db: Db,
  tenantId: string,
  input: PendingEntriesInput,
  templateId: string | undefined,
  meta: ReportMeta,
): Promise<{ report: Report; rows: number }> {
  const template = templateId ? await loadTemplate(db, tenantId, 'items', templateId) : {};
  const values: unknown[] = [tenantId];
  const where = [`m.tenant_id = $1`, `m.match_type = 'classification'`, `m.status = 'confirmed'`];
  if (input.bankAccountId) {
    values.push(input.bankAccountId);
    where.push(`b.bank_account_id = $${values.length}`);
  }
  if (input.dateFrom) {
    values.push(input.dateFrom);
    where.push(`b.posted_date >= $${values.length}::date`);
  }
  if (input.dateTo) {
    values.push(input.dateTo);
    where.push(`b.posted_date <= $${values.length}::date`);
  }
  values.push(exportLimits.maxRows + 1);
  const result = await db.query<{
    date: string;
    description: string;
    document: string | null;
    amount: string;
    category: string | null;
    account: string | null;
  }>(
    `SELECT b.posted_date AS date, b.description_raw AS description, b.document, b.amount_cents::text AS amount,
            c.name AS category, a.name AS account
       FROM matches m
       JOIN match_items i ON i.tenant_id = m.tenant_id AND i.match_id = m.id AND i.side = 'bank'
       JOIN bank_transactions b ON b.tenant_id = m.tenant_id AND b.id = i.bank_transaction_id
       LEFT JOIN categories c ON c.tenant_id = m.tenant_id AND c.id = m.category_id
       LEFT JOIN bank_accounts a ON a.tenant_id = b.tenant_id AND a.id = b.bank_account_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.posted_date, b.id
      LIMIT $${values.length}::int`,
    values,
  );
  if (result.rows.length > exportLimits.maxRows) throw tooLarge();
  const amounts = result.rows.map((row) => ({ amountCents: Number(row.amount) }));
  const section: Section = {
    title: 'A lançar',
    columns: [
      { key: 'date', label: 'Data', kind: 'date', width: 9 },
      { key: 'description', label: 'Descrição', kind: 'text', width: 30 },
      { key: 'document', label: 'Documento', kind: 'text', width: 12 },
      { key: 'amount', label: 'Valor', kind: 'money', width: 12 },
      { key: 'category', label: 'Categoria', kind: 'text', width: 18 },
      { key: 'account', label: 'Conta', kind: 'text', width: 14 },
    ],
    rows: result.rows.map((row, index) => [
      row.date,
      row.description,
      row.document,
      amounts[index]!.amountCents,
      row.category,
      row.account,
    ]),
    totals: itemTotals(amounts),
  };
  return {
    rows: result.rows.length,
    report: {
      ...meta,
      title: templateId ? (template.title ?? 'Lançamentos a registrar') : 'Lançamentos a registrar',
      subtitle: [periodLabel(input.dateFrom, input.dateTo), 'Classificações confirmadas sem lançamento no sistema financeiro'],
      footer: template.footer ?? '',
      sections: [section],
    },
  };
}
