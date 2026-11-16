import { basename } from 'node:path';
import { importProfileConfigSchema, sha256Hex, type ImportProfileConfig } from '@concilia/core';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/context';
import { decodeTimeCursor, encodeTimeCursor } from '../../http/cursor';
import { badRequest, conflict, notFound } from '../../http/errors';
import { accepted, created, file, route, type RouteDefinition } from '../../http/route';
import { enqueue, findJobByKey, jobView, requeueJob } from '../../jobs/queue';
import { buildPreview, CONTENT_TYPES, detectFileFormat, type FileFormat } from './files';
import {
  batchView,
  BATCH_SELECT,
  findBankAccount,
  assertFileNotPurged,
  findBatch,
  findProfile,
  IMPORT_JOB_TYPE,
  loadBatchFile,
  type BatchConfig,
  type BatchRow,
  type ProfileRow,
} from './queries';

// ---------------------------------------------------------------------------
// Envio do arquivo
// ---------------------------------------------------------------------------

interface Upload {
  fields: Record<string, string>;
  file: { name: string; content: Buffer } | null;
}

/** Lê o formulário multipart. Arquivo acima do limite interrompe com 413 (tratado pelo manipulador de erros). */
async function readUpload(req: FastifyRequest): Promise<Upload> {
  if (!req.isMultipart()) throw badRequest('Envie o arquivo como multipart/form-data.', 'multipart_required');
  const fields: Record<string, string> = {};
  let upload: Upload['file'] = null;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const content = await part.toBuffer();
      upload ??= { name: part.filename, content };
    } else if (typeof part.value === 'string') {
      fields[part.fieldname] = part.value;
    }
  }
  return { fields, file: upload };
}

const optionalUuid = z.preprocess((value) => (value === '' ? undefined : value), z.uuid().optional());

const uploadFields = z.object({
  sourceKind: z.enum(['bank', 'ledger']),
  bankAccountId: optionalUuid,
  profileId: optionalUuid,
});

function cleanFileName(name: string): string {
  const base = basename(name.replace(/\\/g, '/')).trim();
  return (base || 'arquivo').slice(0, 255);
}

async function activeProfile(db: Db, tenantId: string, id: string, sourceKind: string): Promise<ProfileRow> {
  const profile = await findProfile(db, tenantId, id);
  if (!profile || !profile.active) throw badRequest('Perfil de importação inexistente ou inativo.', 'invalid_profile');
  if (profile.source_kind !== sourceKind) {
    throw badRequest('O perfil de importação é de outra origem (extrato × lançamentos).', 'invalid_profile');
  }
  return profile;
}

function profileConfig(profile: ProfileRow | null): ImportProfileConfig | null {
  if (!profile) return null;
  const parsed = importProfileConfigSchema.safeParse(profile.config);
  return parsed.success ? parsed.data : null;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === '23505' && pgError.constraint === constraint;
}

async function existingFileBatch(
  db: Db,
  tenantId: string,
  sourceKind: string,
  bankAccountId: string | null,
  sha256: string,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM import_batches
      WHERE tenant_id = $1 AND source_kind = $2 AND bank_account_id IS NOT DISTINCT FROM $3 AND file_sha256 = $4
        AND status NOT IN ('failed', 'canceled')
      LIMIT 1`,
    [tenantId, sourceKind, bankAccountId, sha256],
  );
  return result.rows[0]?.id ?? null;
}

function duplicateFile(batchId: string) {
  return conflict('Este arquivo já foi importado para esta conta.', 'duplicate_file', { batchId });
}

// ---------------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------------

const idParams = z.object({ id: z.uuid() });

const listQuery = z.object({
  sourceKind: z.enum(['bank', 'ledger']).optional(),
  status: z
    .enum(['uploaded', 'queued', 'processing', 'completed', 'completed_with_errors', 'failed', 'canceled'])
    .optional(),
  bankAccountId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

const confirmBody = z.object({
  profileId: z.uuid().optional(),
  config: z.unknown().optional(),
  allowAccountMismatch: z.boolean().default(false),
  saveProfileAs: z.string().trim().min(1).max(120).optional(),
});

const reprocessBody = z.object({ allowAccountMismatch: z.boolean().optional() });

const rejectionsQuery = z.object({
  kind: z.enum(['invalid', 'conflict']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.coerce.number().int().min(1).optional(),
});

const previewQuery = z.object({ sheetName: z.string().trim().min(1).max(100).optional() });

async function previewOf(db: Db, batch: BatchRow, sheetName?: string): Promise<Record<string, unknown>> {
  assertFileNotPurged(batch, 'gerar a prévia');
  const content = await loadBatchFile(db, batch.tenant_id, batch.id);
  if (!content) throw notFound('O arquivo original não está mais disponível.');
  const account = batch.bank_account_id ? await findBankAccount(db, batch.tenant_id, batch.bank_account_id) : null;
  const profile = batch.profile_id ? await findProfile(db, batch.tenant_id, batch.profile_id) : null;
  const mapping = importProfileConfigSchema.safeParse(batch.config?.mapping);
  return buildPreview({
    format: batch.file_format,
    sourceKind: batch.source_kind,
    content,
    accountNumber: account?.account_number ?? null,
    profileConfig: mapping.success ? mapping.data : profileConfig(profile),
    sheetName: sheetName ?? null,
  });
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

export const routes: RouteDefinition[] = [
  route({
    tags: ['importação'],
    auth: 'session',
    permission: 'imports.create',
    method: 'POST',
    url: '/imports',
    summary: 'Enviar arquivo de extrato (OFX, CSV, XLSX) ou de lançamentos (CSV, XLSX)',
    multipart: true,
    handler: async ({ db, tenantId, auth, req, audit }) => {
      const upload = await readUpload(req);
      const fields = uploadFields.parse(upload.fields);
      if (!upload.file) throw badRequest('Selecione um arquivo.', 'file_required');
      if (upload.file.content.length === 0) throw badRequest('O arquivo está vazio.', 'empty_file');
      const fileName = cleanFileName(upload.file.name);
      const content = upload.file.content;

      const format: FileFormat = detectFileFormat(fileName, content);
      if (fields.sourceKind === 'ledger' && format === 'ofx') {
        throw badRequest('Arquivos de lançamentos devem ser CSV ou XLSX.', 'unsupported_format');
      }
      if (fields.sourceKind === 'bank' && !fields.bankAccountId) {
        throw badRequest('Selecione a conta bancária do extrato.', 'bank_account_required');
      }
      const account = fields.bankAccountId ? await findBankAccount(db, tenantId, fields.bankAccountId) : null;
      if (fields.bankAccountId && (!account || !account.active)) {
        throw badRequest('Conta bancária inexistente ou inativa.', 'invalid_bank_account');
      }
      const profile = fields.profileId ? await activeProfile(db, tenantId, fields.profileId, fields.sourceKind) : null;

      const sha256 = sha256Hex(content);
      const bankAccountId = account?.id ?? null;
      const previous = await existingFileBatch(db, tenantId, fields.sourceKind, bankAccountId, sha256);
      if (previous) throw duplicateFile(previous);

      const preview = await buildPreview({
        format,
        sourceKind: fields.sourceKind,
        content,
        accountNumber: account?.account_number ?? null,
        profileConfig: profileConfig(profile),
      });

      // Ponto de salvamento: em corrida com outro envio do mesmo arquivo, responde 409 com o lote vencedor.
      await db.query('SAVEPOINT import_upload');
      let id: string;
      try {
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO import_batches
             (tenant_id, source_kind, bank_account_id, profile_id, origin, file_name, file_format, file_sha256,
              file_size, status, created_by)
           VALUES ($1, $2, $3, $4, 'upload', $5, $6, $7, $8, 'uploaded', $9)
           RETURNING id`,
          [tenantId, fields.sourceKind, bankAccountId, profile?.id ?? null, fileName, format, sha256, content.length, auth.userId],
        );
        id = inserted.rows[0]!.id;
      } catch (error) {
        if (!isUniqueViolation(error, 'import_batches_file_unique')) throw error;
        await db.query('ROLLBACK TO SAVEPOINT import_upload');
        const winner = await existingFileBatch(db, tenantId, fields.sourceKind, bankAccountId, sha256);
        throw winner ? duplicateFile(winner) : conflict('Este arquivo já foi importado para esta conta.', 'duplicate_file');
      }
      await db.query('RELEASE SAVEPOINT import_upload');
      await db.query('INSERT INTO import_files (batch_id, tenant_id, content) VALUES ($1, $2, $3)', [id, tenantId, content]);

      await audit({
        action: 'import.uploaded',
        entityType: 'import_batch',
        entityId: id,
        summary: `Arquivo ${fileName} enviado para importação`,
        after: { sourceKind: fields.sourceKind, bankAccountId, profileId: profile?.id ?? null, fileName, format },
        metadata: { sha256, size: content.length },
      });
      return created({ id, fileFormat: format, fileName, sha256, preview });
    },
  }),

  route({
    tags: ['importação'],
    auth: 'session',
    permission: 'imports.view',
    method: 'GET',
    url: '/imports',
    summary: 'Listar importações',
    query: listQuery,
    handler: async ({ db, tenantId, query }) => {
      const values: unknown[] = [tenantId];
      const where = ['b.tenant_id = $1'];
      const add = (clause: string, value: unknown) => {
        values.push(value);
        where.push(clause.replace('?', `$${values.length}`));
      };
      if (query.sourceKind) add('b.source_kind = ?', query.sourceKind);
      if (query.status) add('b.status = ?', query.status);
      if (query.bankAccountId) add('b.bank_account_id = ?', query.bankAccountId);
      if (query.cursor) {
        const cursor = decodeTimeCursor(query.cursor);
        values.push(cursor.at, cursor.id);
        where.push(`(b.created_at, b.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(query.limit + 1);
      const result = await db.query<BatchRow>(
        `${BATCH_SELECT} WHERE ${where.join(' AND ')} ORDER BY b.created_at DESC, b.id DESC LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, query.limit);
      const last = rows.at(-1);
      const items = rows.map(batchView);
      return result.rows.length > query.limit && last
        ? { items, nextCursor: encodeTimeCursor({ at: last.cursor_at, id: last.id }) }
        : { items };
    },
  }),

  route({
    tags: ['importação'],
    auth: 'session',
    permission: 'imports.view',
    method: 'GET',
    url: '/imports/:id',
    summary: 'Consultar uma importação, com estatísticas e trabalho',
    params: idParams,
    handler: async ({ db, tenantId, params }) => {
      const batch = await findBatch(db, tenantId, params.id);
      const job = await findJobByKey(db, tenantId, IMPORT_JOB_TYPE, batch.id);
      return { ...batchView(batch), job: job ? jobView(job) : null };
    },
  }),

  route({
    tags: ['importação'],
    auth: 'session',
    permission: 'imports.view',
    method: 'GET',
    url: '/imports/:id/preview',
    summary: 'Pré-visualizar o arquivo de uma importação',
    params: idParams,
    query: previewQuery,
    handler: async ({ db, tenantId, params, query }) => {
      const batch = await findBatch(db, tenantId, params.id);
      return { id: batch.id, fileFormat: batch.file_format, preview: await previewOf(db, batch, query.sheetName) };
    },
  }),

  route({
    tags: ['importação'],
    auth: 'session',
    permission: 'imports.create',
    method: 'POST',
    url: '/imports/:id/confirm',
    summary: 'Confirmar o mapeamento e enfileirar o processamento',
    params: idParams,
    body: confirmBody,
    handler: async ({ db, tenantId, auth, params, body, audit }) => {
      const batch = await findBatch(db, tenantId, params.id, true);
      if (batch.status !== 'uploaded') {
        throw conflict('Esta importação já foi confirmada ou cancelada.', 'invalid_status', { status: batch.status });
      }

      let mapping: ImportProfileConfig | null = null;
      let profileId = batch.profile_id;
      if (batch.file_format !== 'ofx') {
        if (body.config !== undefined) {
          mapping = importProfileConfigSchema.parse(body.config);
        } else {
          const chosen = body.profileId ?? batch.profile_id;
          if (!chosen) throw badRequest('Informe o perfil de importação ou o mapeamento de colunas.', 'config_required');
          const profile = await activeProfile(db, tenantId, chosen, batch.source_kind);
          mapping = profileConfig(profile);
          if (!mapping) throw badRequest('O perfil de importação tem configuração inválida.', 'invalid_profile');
          profileId = profile.id;
        }
        if (body.saveProfileAs) {
          try {
            const saved = await db.query<{ id: string }>(
              `INSERT INTO import_profiles (tenant_id, name, source_kind, file_format, config)
               VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [tenantId, body.saveProfileAs, batch.source_kind, batch.file_format, JSON.stringify(mapping)],
            );
            profileId = saved.rows[0]!.id;
          } catch (error) {
            if (isUniqueViolation(error, 'import_profiles_tenant_id_name_key')) {
              throw conflict('Já existe um perfil de importação com este nome.', 'profile_name_taken');
            }
            throw error;
          }
          await audit({
            action: 'import_profile.created',
            entityType: 'import_profile',
            entityId: profileId,
            summary: `Perfil de importação ${body.saveProfileAs} criado a partir de uma importação`,
            after: { name: body.saveProfileAs, sourceKind: batch.source_kind, fileFormat: batch.file_format, config: mapping },
          });
        }
      }

      const config: BatchConfig = { mapping, allowAccountMismatch: body.allowAccountMismatch };
      await db.query(
        `UPDATE import_batches SET status = 'queued', config = $3, profile_id = $4 WHERE tenant_id = $1 AND id = $2`,
        [tenantId, batch.id, JSON.stringify(config), profileId],
      );
      const { job } = await enqueue(db, {
        tenantId,
        type: IMPORT_JOB_TYPE,
        payload: { batchId: batch.id },
        idempotencyKey: batch.id,
        createdBy: auth.userId,
      });
      await audit({
        action: 'import.confirmed',
        entityType: 'import_batch',
        entityId: batch.id,
        summary: `Importação de ${batch.file_name} confirmada e enfileirada`,
        before: { status: batch.status },
        after: { status: 'queued', profileId, config },
        metadata: { jobId: job.id },
      });
      return accepted({ id: batch.id, jobId: job.id });
    },
  }),

  route({
    tags: ['importação'],
    auth: 'session',
    permission: 'imports.create',
    method: 'POST',
    url: '/imports/:id/cancel',
    summary: 'Cancelar uma importação ainda não confirmada',
    params: idParams,
    handler: async ({ db, tenantId, params, audit }) => {
      const batch = await findBatch(db, tenantId, params.id, true);
      if (batch.status !== 'uploaded') {
        throw conflict('Só é possível cancelar importações ainda não confirmadas.', 'invalid_status', {
          status: batch.status,
        });
      }
      await db.query(`UPDATE import_batches SET status = 'canceled' WHERE tenant_id = $1 AND id = $2`, [tenantId, batch.id]);
      await audit({
        action: 'import.canceled',
        entityType: 'import_batch',
        entityId: batch.id,
        summary: `Importação de ${batch.file_name} cancelada`,
        before: { status: batch.status },
        after: { status: 'canceled' },
      });
      return batchView(await findBatch(db, tenantId, batch.id));
    },
  }),

  route({
    tags: ['importação'],
    auth: 'session',
    permission: 'imports.create',
    method: 'POST',
    url: '/imports/:id/reprocess',
    summary: 'Reprocessar uma importação concluída ou falha (não duplica registros)',
    params: idParams,
    body: reprocessBody,
    handler: async ({ db, tenantId, auth, params, body, audit }) => {
      const batch = await findBatch(db, tenantId, params.id, true);
      assertFileNotPurged(batch, 'reprocessar a importação');
      if (!['completed', 'completed_with_errors', 'failed'].includes(batch.status)) {
        throw conflict('Só é possível reprocessar importações concluídas ou falhas.', 'invalid_status', {
          status: batch.status,
        });
      }
      const config: BatchConfig = {
        mapping: batch.config?.mapping ?? null,
        allowAccountMismatch: body.allowAccountMismatch ?? batch.config?.allowAccountMismatch ?? false,
      };
      try {
        await db.query('SAVEPOINT import_reprocess');
        await db.query(
          `UPDATE import_batches SET status = 'queued', error = NULL, processed_at = NULL, config = $3
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, batch.id, JSON.stringify(config)],
        );
        await db.query('RELEASE SAVEPOINT import_reprocess');
      } catch (error) {
        if (!isUniqueViolation(error, 'import_batches_file_unique')) throw error;
        await db.query('ROLLBACK TO SAVEPOINT import_reprocess');
        const other = await existingFileBatch(db, tenantId, batch.source_kind, batch.bank_account_id, batch.file_sha256);
        throw other ? duplicateFile(other) : conflict('Este arquivo já foi importado para esta conta.', 'duplicate_file');
      }

      const existing = await findJobByKey(db, tenantId, IMPORT_JOB_TYPE, batch.id);
      let jobId: string;
      if (existing) {
        const requeued = await requeueJob(db, tenantId, existing.id);
        if (!requeued) throw conflict('O processamento desta importação ainda está em andamento.', 'job_in_progress');
        jobId = requeued.id;
      } else {
        const { job } = await enqueue(db, {
          tenantId,
          type: IMPORT_JOB_TYPE,
          payload: { batchId: batch.id },
          idempotencyKey: batch.id,
          createdBy: auth.userId,
        });
        jobId = job.id;
      }
      await audit({
        action: 'import.reprocess_requested',
        entityType: 'import_batch',
        entityId: batch.id,
        summary: `Reprocessamento de ${batch.file_name} solicitado`,
        before: { status: batch.status, stats: batch.stats },
        after: { status: 'queued', config },
        metadata: { jobId },
      });
      return accepted({ id: batch.id, jobId });
    },
  }),

  route({
    tags: ['importação'],
    auth: 'session',
    permission: 'imports.view',
    method: 'GET',
    url: '/imports/:id/rejections',
    summary: 'Linhas rejeitadas de uma importação, com o motivo',
    params: idParams,
    query: rejectionsQuery,
    handler: async ({ db, tenantId, params, query }) => {
      const batch = await findBatch(db, tenantId, params.id);
      const values: unknown[] = [tenantId, batch.id];
      const where = ['tenant_id = $1', 'batch_id = $2'];
      if (query.kind) {
        values.push(query.kind);
        where.push(`kind = $${values.length}`);
      }
      if (query.cursor) {
        values.push(query.cursor);
        where.push(`id > $${values.length}`);
      }
      values.push(query.limit + 1);
      const result = await db.query<{
        id: string;
        row_number: number;
        kind: string;
        reason: string;
        raw: unknown;
        created_at: Date;
      }>(
        `SELECT id, row_number, kind, reason, raw, created_at FROM import_rejections
          WHERE ${where.join(' AND ')} ORDER BY id LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, query.limit);
      const items = rows.map((row) => ({
        id: Number(row.id),
        rowNumber: row.row_number,
        kind: row.kind,
        reason: row.reason,
        raw: row.raw,
        createdAt: row.created_at.toISOString(),
      }));
      const last = rows.at(-1);
      return result.rows.length > query.limit && last ? { items, nextCursor: String(last.id) } : { items };
    },
  }),

  route({
    tags: ['importação'],
    auth: 'session',
    permission: 'imports.view',
    method: 'GET',
    url: '/imports/:id/file',
    summary: 'Baixar o arquivo original de uma importação',
    params: idParams,
    handler: async ({ db, tenantId, params, audit }) => {
      const batch = await findBatch(db, tenantId, params.id);
      assertFileNotPurged(batch, 'baixá-lo');
      const content = await loadBatchFile(db, tenantId, batch.id);
      if (!content) throw notFound('O arquivo original não está mais disponível.');
      await audit({
        action: 'import.file_downloaded',
        entityType: 'import_batch',
        entityId: batch.id,
        summary: `Arquivo original ${batch.file_name} baixado`,
        metadata: { sha256: batch.file_sha256 },
      });
      return file(batch.file_name, CONTENT_TYPES[batch.file_format], content);
    },
  }),
];
