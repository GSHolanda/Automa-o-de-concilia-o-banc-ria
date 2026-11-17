import { LEDGER_API_MAX_ENTRIES, ledgerEntryInputV1Schema, sha256Hex } from '@concilia/core';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../http/errors';
import { accepted, route, type RouteDefinition } from '../../http/route';
import { findJobByKey } from '../../jobs/queue';
import { IMPORT_JOB_TYPE } from '../imports/queries';
import { createJsonBatch } from './pull';

const entriesBody = z.object({
  bankAccountId: z.uuid().nullish(),
  entries: z.array(ledgerEntryInputV1Schema).min(1).max(LEDGER_API_MAX_ENTRIES),
});

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

function idempotencyKeyOf(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const key = value?.trim() ?? '';
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw badRequest(
      'Informe o cabeçalho Idempotency-Key (1 a 200 caracteres visíveis, sem espaços).',
      'idempotency_key_required',
    );
  }
  return key;
}

export const routes: RouteDefinition[] = [
  route({
    tags: ['api de entrada'],
    auth: 'api_token',
    permission: null,
    scope: 'ledger:write',
    module: 'api.inbound',
    method: 'POST',
    url: '/integrations/ledger/entries',
    summary: 'Enviar lançamentos do sistema financeiro (até 1.000, idempotente por Idempotency-Key)',
    body: entriesBody,
    handler: async ({ db, tenantId, auth, body, req, audit }) => {
      const key = idempotencyKeyOf(req.headers['idempotency-key']);
      const bankAccountId = body.bankAccountId ?? null;
      const content = Buffer.from(JSON.stringify({ version: 1, source: 'api', bankAccountId, entries: body.entries }), 'utf8');
      const contentSha = sha256Hex(content);

      // Mesma chave em requisições simultâneas: uma espera a outra e devolve o mesmo lote.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`api-idempotency:${tenantId}:${key}`]);
      await db.query('UPDATE api_tokens SET last_used_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId, auth.apiTokenId]);
      const previous = await db.query<{ id: string; file_sha256: string }>(
        `SELECT id, file_sha256 FROM import_batches WHERE tenant_id = $1 AND origin = 'api' AND idempotency_key = $2`,
        [tenantId, key],
      );
      const existing = previous.rows[0];
      if (existing) {
        if (existing.file_sha256 !== contentSha) {
          throw conflict('Esta Idempotency-Key já foi usada com outro conteúdo.', 'idempotency_key_reused', {
            batchId: existing.id,
          });
        }
        const job = await findJobByKey(db, tenantId, IMPORT_JOB_TYPE, existing.id);
        return accepted({ batchId: existing.id, jobId: job?.id ?? null, replayed: true });
      }

      if (bankAccountId) {
        const account = await db.query('SELECT 1 FROM bank_accounts WHERE tenant_id = $1 AND id = $2 AND active', [
          tenantId,
          bankAccountId,
        ]);
        if (account.rows.length === 0) throw badRequest('Conta bancária inexistente ou inativa.', 'invalid_bank_account');
      }

      const batch = await createJsonBatch(
        { db, tenantId },
        {
          origin: 'api',
          fileName: `api-${new Date().toISOString().slice(0, 10)}.json`,
          content,
          bankAccountId,
          createdBy: null,
          idempotencyKey: key,
          apiTokenId: auth.apiTokenId ?? null,
        },
      );
      if (!batch.created) {
        throw conflict('Estes lançamentos já foram recebidos em outro lote.', 'duplicate_file', { batchId: batch.batchId });
      }
      await audit({
        action: 'import.api_received',
        entityType: 'import_batch',
        entityId: batch.batchId,
        summary: `${body.entries.length} lançamento(s) recebido(s) pela API`,
        after: { origin: 'api', bankAccountId, entries: body.entries.length },
        metadata: { idempotencyKey: key, sha256: contentSha, jobId: batch.jobId },
      });
      return accepted({ batchId: batch.batchId, jobId: batch.jobId });
    },
  }),

  route({
    tags: ['api de entrada'],
    auth: 'api_token',
    permission: null,
    scope: 'ledger:write',
    module: 'api.inbound',
    method: 'GET',
    url: '/integrations/ledger/batches/:id',
    summary: 'Situação de um lote recebido pela API, com rejeições',
    params: z.object({ id: z.uuid() }),
    handler: async ({ db, tenantId, params }) => {
      const found = await db.query<{
        id: string;
        status: string;
        stats: Record<string, unknown>;
        error: string | null;
        created_at: Date;
        processed_at: Date | null;
      }>(
        `SELECT id, status, stats, error, created_at, processed_at FROM import_batches
          WHERE tenant_id = $1 AND id = $2 AND origin = 'api'`,
        [tenantId, params.id],
      );
      const batch = found.rows[0];
      if (!batch) throw notFound('Lote não encontrado.');
      const rejections = await db.query<{ row_number: number; kind: string; reason: string }>(
        `SELECT row_number, kind, reason FROM import_rejections
          WHERE tenant_id = $1 AND batch_id = $2 ORDER BY row_number, id LIMIT 1000`,
        [tenantId, batch.id],
      );
      return {
        id: batch.id,
        status: batch.status,
        stats: batch.stats,
        error: batch.error,
        createdAt: batch.created_at.toISOString(),
        processedAt: batch.processed_at?.toISOString() ?? null,
        rejections: rejections.rows.map((row) => ({ rowNumber: row.row_number, kind: row.kind, reason: row.reason })),
      };
    },
  }),
];
