import { diffDays } from '@concilia/core';
import { z } from 'zod';
import { decodeTimeCursor, encodeTimeCursor } from '../../http/cursor';
import { badRequest, notFound } from '../../http/errors';
import { accepted, created, route, type RouteContext, type RouteDefinition } from '../../http/route';
import { enqueue } from '../../jobs/queue';
import { findBankAccount } from '../imports/queries';
import {
  acceptMatch,
  approveMatch,
  bulkAccept,
  classifyItem,
  ignoreItem,
  manualMatch,
  refuseMatch,
  rejectMatch,
  undoMatch,
  type DecisionContext,
} from './decisions';
import {
  findReconItem,
  findRun,
  getMatchView,
  itemHistory,
  matchFiltersSchema,
  queryMatches,
  queryReconItems,
  reconItemFiltersSchema,
  RECON_JOB_TYPE,
  RUN_SELECT,
  runView,
  type RunRow,
} from './queries';
import { rulesSnapshot } from './run';

const MAX_PERIOD_DAYS = 366;

const idParams = z.object({ id: z.uuid() });
const itemParams = z.object({ side: z.enum(['bank', 'ledger']), id: z.uuid() });
const limit = z.coerce.number().int().min(1).max(200).default(50);
const reason = z.string().trim().min(1, 'Informe a justificativa.').max(1000);
const note = z.string().trim().max(1000).optional();

const runBody = z
  .object({ bankAccountId: z.uuid(), periodStart: z.iso.date(), periodEnd: z.iso.date() })
  .refine((value) => value.periodEnd >= value.periodStart, {
    message: 'O fim do período deve ser igual ou posterior ao início.',
    path: ['periodEnd'],
  })
  .refine((value) => diffDays(value.periodStart, value.periodEnd) <= MAX_PERIOD_DAYS, {
    message: `O período pode ter no máximo ${MAX_PERIOD_DAYS} dias.`,
    path: ['periodEnd'],
  });

const runsQuery = z.object({
  bankAccountId: z.uuid().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
  limit,
  cursor: z.string().max(200).optional(),
});

const itemsQuery = reconItemFiltersSchema.extend({ limit, cursor: z.string().max(300).optional() });
const matchesQuery = matchFiltersSchema.extend({ limit, cursor: z.string().max(200).optional() });

const ids = z.array(z.uuid()).max(50);
const manualBody = z.object({
  bankTransactionIds: ids.min(1, 'Selecione ao menos uma transação do extrato.'),
  ledgerEntryIds: ids.min(1, 'Selecione ao menos um lançamento.'),
  note,
});

/** Regras de aprovação efetivas: a configuração da empresa só vale com o módulo `approvals` ativo. */
async function decisionContext<P, Q, B>(ctx: RouteContext<P, Q, B>): Promise<DecisionContext> {
  const settings = await ctx.settings();
  const moduleActive = (await ctx.entitlements()).modules.includes('approvals');
  return {
    db: ctx.db,
    tenantId: ctx.tenantId,
    userId: ctx.auth.userId,
    audit: ctx.audit,
    approvals: { ...settings.approvals, enabled: moduleActive && settings.approvals.enabled },
  };
}

const TAGS = ['conciliação'];

export const routes: RouteDefinition[] = [
  // -- execuções ------------------------------------------------------------
  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.run',
    method: 'POST',
    url: '/reconciliation/runs',
    summary: 'Executar a conciliação de uma conta em um período (assíncrono)',
    body: runBody,
    handler: async ({ db, tenantId, auth, body, audit, settings, entitlements }) => {
      const account = await findBankAccount(db, tenantId, body.bankAccountId);
      if (!account) throw notFound('Conta bancária não encontrada.');
      if (!account.active) throw badRequest('A conta bancária está inativa.', 'invalid_bank_account');
      const rules = rulesSnapshot(await settings(), await entitlements());
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO reconciliation_runs (tenant_id, bank_account_id, period_start, period_end, status, rules_snapshot, started_by)
         VALUES ($1, $2, $3, $4, 'queued', $5, $6) RETURNING id`,
        [tenantId, account.id, body.periodStart, body.periodEnd, JSON.stringify(rules), auth.userId],
      );
      const runId = inserted.rows[0]!.id;
      const { job } = await enqueue(db, {
        tenantId,
        type: RECON_JOB_TYPE,
        payload: { runId },
        idempotencyKey: runId,
        createdBy: auth.userId,
      });
      await audit({
        action: 'reconciliation.run_requested',
        entityType: 'reconciliation_run',
        entityId: runId,
        summary: `Conciliação da conta ${account.name} de ${body.periodStart} a ${body.periodEnd} solicitada`,
        after: { bankAccountId: account.id, periodStart: body.periodStart, periodEnd: body.periodEnd, rules },
        metadata: { jobId: job.id },
      });
      return accepted({ runId, jobId: job.id });
    },
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.view',
    method: 'GET',
    url: '/reconciliation/runs',
    summary: 'Listar execuções de conciliação',
    query: runsQuery,
    handler: async ({ db, tenantId, query }) => {
      const values: unknown[] = [tenantId];
      const where = ['r.tenant_id = $1'];
      const add = (clause: string, value: unknown) => {
        values.push(value);
        where.push(clause.replace('?', `$${values.length}`));
      };
      if (query.bankAccountId) add('r.bank_account_id = ?', query.bankAccountId);
      if (query.status) add('r.status = ?', query.status);
      if (query.cursor) {
        const cursor = decodeTimeCursor(query.cursor);
        values.push(cursor.at, cursor.id);
        where.push(`(r.created_at, r.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(query.limit + 1);
      const result = await db.query<RunRow>(
        `${RUN_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, query.limit);
      const last = rows.at(-1);
      const items = rows.map(runView);
      return result.rows.length > query.limit && last
        ? { items, nextCursor: encodeTimeCursor({ at: last.cursor_at, id: last.id }) }
        : { items };
    },
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.view',
    method: 'GET',
    url: '/reconciliation/runs/:id',
    summary: 'Consultar uma execução de conciliação, com regras usadas e estatísticas',
    params: idParams,
    handler: async ({ db, tenantId, params }) => runView(await findRun(db, tenantId, params.id)),
  }),

  // -- itens ----------------------------------------------------------------
  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.view',
    method: 'GET',
    url: '/reconciliation/items',
    summary: 'Itens de extrato e lançamentos com filtros e pesquisa',
    query: itemsQuery,
    handler: async ({ db, tenantId, query }) => {
      const { limit: pageSize, cursor, ...filters } = query;
      return queryReconItems(db, tenantId, filters, { limit: pageSize, cursor });
    },
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.view',
    method: 'GET',
    url: '/reconciliation/items/:side/:id',
    summary: 'Item com a linha bruta e o histórico de decisões',
    params: itemParams,
    handler: async ({ db, tenantId, params }) => {
      const { item, raw } = await findReconItem(db, tenantId, params.side, params.id);
      return { item, raw, history: await itemHistory(db, tenantId, params.side, params.id) };
    },
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.review',
    method: 'POST',
    url: '/reconciliation/items/ignore',
    summary: 'Ignorar um item na conciliação, com justificativa',
    body: z.object({ side: z.enum(['bank', 'ledger']), id: z.uuid(), reason }),
    handler: async (ctx) => created(await ignoreItem(await decisionContext(ctx), ctx.body)),
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.review',
    method: 'POST',
    url: '/reconciliation/items/classify',
    summary: 'Classificar uma transação sem lançamento correspondente',
    body: z.object({ bankTransactionId: z.uuid(), categoryId: z.uuid(), note }),
    handler: async (ctx) => created(await classifyItem(await decisionContext(ctx), ctx.body)),
  }),

  // -- conciliações ---------------------------------------------------------
  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.view',
    method: 'GET',
    url: '/reconciliation/matches',
    summary: 'Sugestões e conciliações, com os itens dos dois lados',
    query: matchesQuery,
    handler: async ({ db, tenantId, query }) => {
      const { limit: pageSize, cursor, ...filters } = query;
      const page = await queryMatches(db, tenantId, filters, {
        limit: pageSize,
        cursor: cursor ? decodeTimeCursor(cursor) : null,
      });
      return page.hasMore && page.last ? { items: page.rows, nextCursor: encodeTimeCursor(page.last) } : { items: page.rows };
    },
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.view',
    method: 'GET',
    url: '/reconciliation/matches/:id',
    summary: 'Consultar uma sugestão ou conciliação',
    params: idParams,
    handler: async ({ db, tenantId, params }) => getMatchView(db, tenantId, params.id),
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.review',
    method: 'POST',
    url: '/reconciliation/matches/manual',
    summary: 'Conciliar manualmente (1:1, 1:N, N:1); diferença de valor exige observação',
    body: manualBody,
    handler: async (ctx) => created(await manualMatch(await decisionContext(ctx), ctx.body)),
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.review',
    method: 'POST',
    url: '/reconciliation/matches/bulk-accept',
    summary: 'Aceitar em lote sugestões não ambíguas e sem divergência',
    body: z.object({ ids: z.array(z.uuid()).min(1).max(200) }),
    handler: async (ctx) => {
      const results = await bulkAccept(await decisionContext(ctx), ctx.body.ids);
      const acceptedCount = results.filter((result) => result.ok).length;
      return { results, accepted: acceptedCount, failed: results.length - acceptedCount };
    },
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.review',
    method: 'POST',
    url: '/reconciliation/matches/:id/accept',
    summary: 'Aceitar uma sugestão (vai para aprovação quando as regras da empresa exigirem)',
    params: idParams,
    body: z.object({ note }),
    handler: async (ctx) => acceptMatch(await decisionContext(ctx), ctx.params.id, { note: ctx.body.note || undefined }),
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.review',
    method: 'POST',
    url: '/reconciliation/matches/:id/reject',
    summary: 'Rejeitar uma sugestão; o par não é proposto de novo',
    params: idParams,
    body: z.object({ reason }),
    handler: async (ctx) => rejectMatch(await decisionContext(ctx), ctx.params.id, ctx.body.reason),
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.approve',
    method: 'POST',
    url: '/reconciliation/matches/:id/approve',
    summary: 'Aprovar uma conciliação pendente de aprovação',
    params: idParams,
    body: z.object({ note }),
    handler: async (ctx) => approveMatch(await decisionContext(ctx), ctx.params.id, ctx.body.note || undefined),
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.approve',
    method: 'POST',
    url: '/reconciliation/matches/:id/refuse',
    summary: 'Recusar uma conciliação pendente de aprovação e liberar os itens',
    params: idParams,
    body: z.object({ reason }),
    handler: async (ctx) => refuseMatch(await decisionContext(ctx), ctx.params.id, ctx.body.reason),
  }),

  route({
    tags: TAGS,
    auth: 'session',
    permission: 'reconciliation.undo',
    method: 'POST',
    url: '/reconciliation/matches/:id/undo',
    summary: 'Desfazer uma conciliação vigente, com justificativa; os itens voltam a pendente',
    params: idParams,
    body: z.object({ reason }),
    handler: async (ctx) => undoMatch(await decisionContext(ctx), ctx.params.id, ctx.body.reason),
  }),
];
