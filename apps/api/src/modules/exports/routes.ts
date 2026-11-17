import { z } from 'zod';
import { file, route, type RouteContext, type RouteDefinition } from '../../http/route';
import { reconItemFiltersSchema } from '../reconciliation/queries';
import { renderCsv } from './csv';
import {
  buildItemsReport,
  buildPendingEntriesReport,
  buildSummaryReport,
  loadCompanyName,
  type ReportMeta,
} from './data';
import type { Report } from './model';
import { renderPdf } from './pdf';
import { renderXlsx } from './xlsx';

type Format = 'csv' | 'xlsx' | 'pdf';

const CONTENT_TYPES: Record<Format, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

const templateId = z.uuid().optional();
const civilDate = z.iso.date();

const itemsBody = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']),
  filters: reconItemFiltersSchema.default({}),
  templateId,
});
const summaryBody = z.object({
  format: z.enum(['pdf', 'xlsx']),
  bankAccountId: z.uuid(),
  dateFrom: civilDate,
  dateTo: civilDate,
  templateId,
});
const pendingBody = z.object({
  format: z.enum(['csv', 'xlsx']),
  bankAccountId: z.uuid().optional(),
  dateFrom: civilDate.optional(),
  dateTo: civilDate.optional(),
  templateId,
});

async function metaOf(ctx: RouteContext<unknown, unknown, unknown>): Promise<ReportMeta> {
  return { company: await loadCompanyName(ctx.db, ctx.tenantId), generatedBy: ctx.auth.name, generatedAt: new Date() };
}

async function render(report: Report, format: Format, compress: boolean): Promise<Buffer> {
  if (format === 'csv') return renderCsv(report.sections[0]!);
  if (format === 'xlsx') return renderXlsx(report);
  return renderPdf(report, { compress });
}

function fileName(base: string, format: Format, at: Date): string {
  return `${base}-${at.toISOString().slice(0, 10)}.${format}`;
}

/** Gera o arquivo, grava a auditoria na mesma transação e responde o download. */
async function deliver(
  ctx: RouteContext<unknown, unknown, unknown>,
  kind: 'items' | 'summary' | 'pending-entries',
  base: string,
  format: Format,
  built: { report: Report; rows: number },
  filters: unknown,
) {
  const body = await render(built.report, format, ctx.deps.config.nodeEnv !== 'test');
  await ctx.audit({
    action: 'export.created',
    entityType: 'export',
    summary: `Exportação ${format.toUpperCase()} (${kind}) com ${built.rows} linha(s)`,
    after: { report: kind, format, rows: built.rows, filters },
  });
  return file(fileName(base, format, built.report.generatedAt), CONTENT_TYPES[format], body);
}

// Exportar não altera dados de negócio: `write: false` mantém a rota disponível com a licença somente leitura.
export const routes: RouteDefinition[] = [
  route({
    tags: ['exportações'],
    auth: 'session',
    permission: 'exports.create',
    write: false,
    method: 'POST',
    url: '/exports/items',
    summary: 'Exporta os itens do filtro em CSV, XLSX ou PDF',
    body: itemsBody,
    handler: async (ctx) => {
      const { format, filters, templateId: template } = ctx.body;
      const built = await buildItemsReport(ctx.db, ctx.tenantId, filters, template, await metaOf(ctx));
      return deliver(ctx, 'items', 'itens-conciliacao', format, built, filters);
    },
  }),
  route({
    tags: ['exportações'],
    auth: 'session',
    permission: 'exports.create',
    write: false,
    method: 'POST',
    url: '/exports/summary',
    summary: 'Resumo da conciliação de uma conta e período em PDF ou XLSX',
    body: summaryBody,
    handler: async (ctx) => {
      const { format, templateId: template, ...input } = ctx.body;
      const built = await buildSummaryReport(ctx.db, ctx.tenantId, input, template, await metaOf(ctx));
      return deliver(ctx, 'summary', 'resumo-conciliacao', format, built, input);
    },
  }),
  route({
    tags: ['exportações'],
    auth: 'session',
    permission: 'exports.create',
    write: false,
    method: 'POST',
    url: '/exports/pending-entries',
    summary: 'Classificações confirmadas sem lançamento, a registrar no sistema financeiro',
    body: pendingBody,
    handler: async (ctx) => {
      const { format, templateId: template, ...input } = ctx.body;
      const built = await buildPendingEntriesReport(ctx.db, ctx.tenantId, input, template, await metaOf(ctx));
      return deliver(ctx, 'pending-entries', 'lancamentos-a-registrar', format, built, input);
    },
  }),
];
