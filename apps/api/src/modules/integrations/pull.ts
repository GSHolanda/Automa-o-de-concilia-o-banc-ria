import { integrationConfigSchemas, INTEGRATION_MODULES, sha256Hex } from '@concilia/core';
import type { Db } from '../../db/context';
import { enqueue } from '../../jobs/queue';
import type { JobContext, JobHandler, StepsJobContext } from '../../jobs/types';
import { createRestLedgerConnector } from '../../integrations/rest-ledger';
import { scrubSecret } from '../../security/secrets';
import { IMPORT_JOB_TYPE } from '../imports/queries';
import { loadEntitlements } from '../tenancy/entitlements';
import { ERROR_LIMIT, readSecret, recordCheck, type IntegrationRow } from './store';

export const PULL_JOB_TYPE = 'connector.pull';

/** Cria o lote JSON (origem `api` ou `connector`) com o arquivo preservado. Nulo se o mesmo conteúdo já foi importado. */
export async function createJsonBatch(
  context: Pick<JobContext, 'db' | 'tenantId'>,
  input: {
    origin: 'api' | 'connector';
    fileName: string;
    content: Buffer;
    bankAccountId: string | null;
    createdBy: string | null;
    idempotencyKey?: string | null;
    apiTokenId?: string | null;
    integrationId?: string | null;
  },
): Promise<{ batchId: string; jobId: string; created: boolean }> {
  const { db, tenantId } = context;
  const sha256 = sha256Hex(input.content);
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM import_batches
      WHERE tenant_id = $1 AND source_kind = 'ledger' AND file_sha256 = $2
        AND coalesce(bank_account_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND status NOT IN ('failed', 'canceled')
      LIMIT 1`,
    [tenantId, sha256, input.bankAccountId],
  );
  if (existing.rows[0]) {
    const job = await db.query<{ id: string }>(
      `SELECT id FROM jobs WHERE tenant_id = $1 AND type = $2 AND idempotency_key = $3`,
      [tenantId, IMPORT_JOB_TYPE, existing.rows[0].id],
    );
    return { batchId: existing.rows[0].id, jobId: job.rows[0]?.id ?? '', created: false };
  }
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO import_batches
       (tenant_id, source_kind, bank_account_id, origin, file_name, file_format, file_sha256, file_size, status, config,
        created_by, idempotency_key, api_token_id, integration_id)
     VALUES ($1, 'ledger', $2, $3, $4, 'json', $5, $6, 'queued', $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      tenantId,
      input.bankAccountId,
      input.origin,
      input.fileName,
      sha256,
      input.content.length,
      JSON.stringify({ mapping: null, allowAccountMismatch: false }),
      input.createdBy,
      input.idempotencyKey ?? null,
      input.apiTokenId ?? null,
      input.integrationId ?? null,
    ],
  );
  const batchId = inserted.rows[0]!.id;
  await db.query('INSERT INTO import_files (batch_id, tenant_id, content) VALUES ($1, $2, $3)', [batchId, tenantId, input.content]);
  const { job } = await enqueue(db, {
    tenantId,
    type: IMPORT_JOB_TYPE,
    payload: { batchId },
    idempotencyKey: batchId,
    createdBy: input.createdBy,
  });
  return { batchId, jobId: job.id, created: true };
}

/** Integração lida na primeira etapa, ou o motivo para pular o trabalho. */
async function loadPullTarget(db: Db, tenantId: string, integrationId: string): Promise<IntegrationRow | { skipped: string }> {
  const found = await db.query<IntegrationRow>('SELECT * FROM integrations WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    integrationId,
  ]);
  const integration = found.rows[0];
  if (!integration || integration.kind !== 'rest_ledger' || !integration.active) {
    return { skipped: 'Integração inexistente ou inativa.' };
  }
  const entitlements = await loadEntitlements(db, tenantId);
  if (!entitlements.modules.includes(INTEGRATION_MODULES.rest_ledger)) {
    return { skipped: 'Módulo do conector REST desabilitado.' };
  }
  return integration;
}

/** Em etapas: lê a integração, chama a API externa sem transação aberta e grava o lote em transação curta. */
async function pull(context: StepsJobContext): Promise<unknown> {
  const { job, tenantId, deps, transaction } = context;
  const integrationId = typeof job.payload.integrationId === 'string' ? job.payload.integrationId : null;
  const dateFrom = String(job.payload.dateFrom ?? '');
  const dateTo = String(job.payload.dateTo ?? '');
  if (!integrationId) throw new Error('Trabalho de conector sem integração');
  const target = await transaction(({ db }) => loadPullTarget(db, tenantId, integrationId));
  if ('skipped' in target) return { skipped: true, reason: target.skipped };
  const integration = target;

  const config = integrationConfigSchemas.rest_ledger.parse(integration.config);
  let secret: string | null = null;
  let result: Awaited<ReturnType<ReturnType<typeof createRestLedgerConnector>['pull']>>;
  try {
    secret = readSecret(deps.config, integration);
    result = await createRestLedgerConnector(config, secret, { allowPrivate: deps.config.allowPrivateIntegrationHosts }).pull({
      dateFrom,
      dateTo,
    });
  } catch (error) {
    const message = scrubSecret(error instanceof Error ? error.message : 'Falha no conector.', secret).slice(0, ERROR_LIMIT);
    // Chamada real falhou: a integração fica com erro (se não mudou durante a chamada).
    await transaction(({ db }) => recordCheck(db, integration, message));
    throw new Error(message);
  }

  return transaction(async ({ db, audit }) => {
    const accountOk = config.bankAccountId
      ? (
          await db.query('SELECT 1 FROM bank_accounts WHERE tenant_id = $1 AND id = $2 AND active', [
            tenantId,
            config.bankAccountId,
          ])
        ).rows.length > 0
      : false;
    const entries = result.items.map((item, index) => ({ ...item, raw: result.raw[index] ?? null }));
    const content = Buffer.from(
      JSON.stringify({ version: 1, source: 'connector', integrationId, dateFrom, dateTo, entries }),
      'utf8',
    );
    const batch = await createJsonBatch(
      { db, tenantId },
      {
        origin: 'connector',
        fileName: `conector-${dateFrom}-${dateTo}.json`,
        content,
        bankAccountId: accountOk ? config.bankAccountId : null,
        createdBy: job.created_by,
        integrationId,
      },
    );
    await recordCheck(db, integration, null);
    await audit({
      action: 'connector.pulled',
      entityType: 'import_batch',
      entityId: batch.batchId,
      summary: `Conector ${integration.name}: ${entries.length} lançamento(s) de ${dateFrom} a ${dateTo}`,
      after: { batchId: batch.batchId, created: batch.created, items: entries.length },
      metadata: { integrationId, jobId: job.id },
    });
    return { batchId: batch.batchId, importJobId: batch.jobId, items: entries.length, duplicate: !batch.created };
  });
}

export const connectorPullHandler: JobHandler = { transaction: 'steps', run: pull };
