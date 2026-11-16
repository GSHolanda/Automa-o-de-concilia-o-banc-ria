import { randomUUID } from 'node:crypto';
import {
  INTEGRATION_KINDS,
  integrationConfigSchemas,
  integrationDestinationChanged,
  isIsoDate,
  diffDays,
  type IntegrationKind,
} from '@concilia/core';
import { z } from 'zod';
import { badRequest, conflict } from '../../http/errors';
import { accepted, created, noContent, route, type RouteDefinition } from '../../http/route';
import { enqueue } from '../../jobs/queue';
import { PULL_JOB_TYPE } from './pull';
import {
  assertKindModule,
  checkIntegration,
  findIntegration,
  initialStatus,
  integrationAuditView,
  integrationView,
  IntegrationCheckError,
  newIntegrationId,
  recordCheck,
  sealSecret,
  type IntegrationRow,
} from './store';

const idParams = z.object({ id: z.uuid() });
const secretField = z.string().min(1).max(4_000);

const createBody = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  name: z.string().trim().min(1).max(120),
  config: z.record(z.string(), z.unknown()),
  secret: secretField.optional(),
  active: z.boolean().optional(),
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Texto substitui o segredo; nulo remove; ausente mantém. */
  secret: secretField.nullable().optional(),
  active: z.boolean().optional(),
});

const civilDate = z.string().refine(isIsoDate, 'Use data no formato AAAA-MM-DD');
const pullBody = z
  .object({ dateFrom: civilDate, dateTo: civilDate })
  .refine((value) => value.dateTo >= value.dateFrom, { message: 'O fim do período deve ser posterior ao início', path: ['dateTo'] })
  .refine((value) => diffDays(value.dateFrom, value.dateTo) <= 366, { message: 'Período máximo de 366 dias', path: ['dateTo'] });

/** Valida a configuração do tipo; erro vira 400 com os caminhos dos campos. */
function parseConfig(kind: IntegrationKind, config: unknown): Record<string, unknown> {
  const result = integrationConfigSchemas[kind].safeParse(config);
  if (!result.success) {
    throw badRequest(
      'Configuração da integração inválida.',
      'validation_error',
      result.error.issues.map((issue) => ({ path: ['config', ...issue.path].join('.'), message: issue.message })),
    );
  }
  return result.data as Record<string, unknown>;
}

export const routes: RouteDefinition[] = [
  route({
    tags: ['integrações'],
    auth: 'session',
    permission: 'integrations.manage',
    method: 'GET',
    url: '/integrations',
    summary: 'Listar integrações',
    query: z.object({ kind: z.enum(INTEGRATION_KINDS).optional() }),
    handler: async ({ db, tenantId, query, entitlements }) => {
      const result = await db.query<IntegrationRow>(
        `SELECT * FROM integrations WHERE tenant_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY kind, name, id`,
        [tenantId, query.kind ?? null],
      );
      const modules = (await entitlements()).modules;
      return { items: result.rows.map((row) => integrationView(row, modules)) };
    },
  }),

  route({
    tags: ['integrações'],
    auth: 'session',
    permission: 'integrations.manage',
    method: 'POST',
    url: '/integrations',
    summary: 'Cadastrar integração (o segredo é só de escrita)',
    body: createBody,
    handler: async ({ db, tenantId, auth, body, deps, audit, entitlements }) => {
      const current = await entitlements();
      assertKindModule(current, body.kind);
      const config = parseConfig(body.kind, body.config);
      const id = newIntegrationId();
      const ciphertext = body.secret ? sealSecret(deps.config, tenantId, id, body.secret) : null;
      const inserted = await db.query<IntegrationRow>(
        `INSERT INTO integrations
           (id, tenant_id, kind, name, config, secret_ciphertext, secret_key_version, status, active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          id,
          tenantId,
          body.kind,
          body.name,
          JSON.stringify(config),
          ciphertext,
          ciphertext ? deps.config.secretsKeyVersion : null,
          initialStatus(body.kind, config, ciphertext !== null),
          body.active ?? true,
          auth.userId,
        ],
      );
      await audit({
        action: 'integration.created',
        entityType: 'integration',
        entityId: id,
        summary: `Integração ${body.name} (${body.kind}) cadastrada`,
        after: integrationAuditView(inserted.rows[0]!, current.modules),
      });
      return created(integrationView(inserted.rows[0]!, current.modules));
    },
  }),

  route({
    tags: ['integrações'],
    auth: 'session',
    permission: 'integrations.manage',
    method: 'GET',
    url: '/integrations/:id',
    summary: 'Detalhar integração',
    params: idParams,
    handler: async ({ db, tenantId, params, entitlements }) => {
      const row = await findIntegration(db, tenantId, params.id);
      return integrationView(row, (await entitlements()).modules);
    },
  }),

  route({
    tags: ['integrações'],
    auth: 'session',
    permission: 'integrations.manage',
    method: 'PATCH',
    url: '/integrations/:id',
    summary: 'Alterar integração; mudança de configuração ou segredo exige novo teste',
    params: idParams,
    body: updateBody,
    handler: async ({ db, tenantId, params, body, deps, audit, entitlements }) => {
      const current = await entitlements();
      const row = await findIntegration(db, tenantId, params.id, true);
      assertKindModule(current, row.kind);
      const config = body.config === undefined ? row.config : parseConfig(row.kind, body.config);
      // O segredo guardado nunca segue para um destino novo: é preciso informá-lo de novo ou apagá-lo.
      if (row.secret_ciphertext && body.secret === undefined && integrationDestinationChanged(row.kind, row.config, config)) {
        throw badRequest(
          'Ao mudar o endereço ou a forma de autenticação, informe o segredo de novo (ou envie secret nulo para apagá-lo).',
          'secret_required',
        );
      }
      let ciphertext = row.secret_ciphertext;
      if (body.secret === null) ciphertext = null;
      else if (body.secret !== undefined) ciphertext = sealSecret(deps.config, tenantId, row.id, body.secret);
      const changed = body.config !== undefined || body.secret !== undefined;
      const updated = await db.query<IntegrationRow>(
        `UPDATE integrations
            SET name = $3, config = $4, secret_ciphertext = $5, secret_key_version = $6, active = $7,
                status = CASE WHEN $8 THEN $9 ELSE status END,
                last_error = CASE WHEN $8 THEN NULL ELSE last_error END,
                last_checked_at = CASE WHEN $8 THEN NULL ELSE last_checked_at END
          WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [
          tenantId,
          row.id,
          body.name ?? row.name,
          JSON.stringify(config),
          ciphertext,
          ciphertext ? (body.secret ? deps.config.secretsKeyVersion : row.secret_key_version) : null,
          body.active ?? row.active,
          changed,
          initialStatus(row.kind, config, ciphertext !== null),
        ],
      );
      const view = integrationView(updated.rows[0]!, current.modules);
      await audit({
        action: 'integration.updated',
        entityType: 'integration',
        entityId: row.id,
        summary: `Integração ${view.name} alterada${body.secret !== undefined ? ' (segredo alterado)' : ''}`,
        before: integrationAuditView(row),
        after: integrationAuditView(updated.rows[0]!, current.modules),
      });
      return view;
    },
  }),

  route({
    tags: ['integrações'],
    auth: 'session',
    permission: 'integrations.manage',
    method: 'DELETE',
    url: '/integrations/:id',
    summary: 'Excluir integração sem uso',
    params: idParams,
    handler: async ({ db, tenantId, params, audit }) => {
      const row = await findIntegration(db, tenantId, params.id, true);
      await db.query('DELETE FROM integrations WHERE tenant_id = $1 AND id = $2', [tenantId, row.id]);
      await audit({
        action: 'integration.deleted',
        entityType: 'integration',
        entityId: row.id,
        summary: `Integração ${row.name} excluída`,
        before: integrationAuditView(row),
      });
      return noContent();
    },
  }),

  route({
    tags: ['integrações'],
    auth: 'session',
    permission: 'integrations.manage',
    method: 'POST',
    url: '/integrations/:id/test',
    summary: 'Testar integração com chamada real (grava verified ou error)',
    params: idParams,
    // A chamada externa (até dezenas de segundos) acontece sem transação aberta.
    transaction: 'steps',
    handler: async ({ tenantId, params, deps, transaction }) => {
      const row = await transaction(async ({ db, entitlements }) => {
        const found = await findIntegration(db, tenantId, params.id);
        assertKindModule(await entitlements(), found.kind);
        if (!found.active) throw conflict('A integração está inativa.', 'integration_inactive');
        return found;
      });
      let error: string | null = null;
      try {
        await checkIntegration(deps.config, row);
      } catch (failure) {
        error = failure instanceof IntegrationCheckError ? failure.message : 'Falha ao testar a integração.';
      }
      return transaction(async ({ db, audit, entitlements }) => {
        const updated = await recordCheck(db, row, error);
        if (!updated) {
          throw conflict('A integração foi alterada ou excluída durante o teste. Teste de novo.', 'integration_changed');
        }
        const view = integrationView(updated, (await entitlements()).modules);
        await audit({
          action: 'integration.tested',
          entityType: 'integration',
          entityId: row.id,
          summary: error === null ? `Integração ${row.name} verificada` : `Teste da integração ${row.name} falhou: ${error}`,
          after: { status: view.status, lastError: view.lastError },
        });
        return view;
      });
    },
  }),

  route({
    tags: ['integrações'],
    auth: 'session',
    permission: 'imports.create',
    module: 'connector.rest',
    method: 'POST',
    url: '/integrations/:id/pull',
    summary: 'Buscar lançamentos do período no conector REST (trabalho connector.pull)',
    params: idParams,
    body: pullBody,
    handler: async ({ db, tenantId, auth, params, body, audit }) => {
      const row = await findIntegration(db, tenantId, params.id);
      if (row.kind !== 'rest_ledger') throw badRequest('A integração não é um conector REST.', 'invalid_integration');
      if (!row.active) throw conflict('A integração está inativa.', 'integration_inactive');
      if (row.status === 'not_configured') {
        throw conflict('A integração não está configurada.', 'integration_not_configured');
      }
      const { job } = await enqueue(db, {
        tenantId,
        type: PULL_JOB_TYPE,
        payload: { integrationId: row.id, dateFrom: body.dateFrom, dateTo: body.dateTo },
        idempotencyKey: randomUUID(),
        createdBy: auth.userId,
      });
      await audit({
        action: 'connector.pull_requested',
        entityType: 'integration',
        entityId: row.id,
        summary: `Busca de lançamentos de ${body.dateFrom} a ${body.dateTo} no conector ${row.name}`,
        after: { dateFrom: body.dateFrom, dateTo: body.dateTo, jobId: job.id },
      });
      return accepted({ jobId: job.id });
    },
  }),
];
