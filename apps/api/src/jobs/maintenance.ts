import { withContext } from '../db/context';
import { enqueue } from './queue';
import type { JobDeps } from './types';

export const PURGE_FILES_JOB_TYPE = 'maintenance.purge_import_files';

/** Intervalo entre verificações de agendamento no trabalhador contínuo. A chave com a data limita a um por dia. */
export const MAINTENANCE_CHECK_INTERVAL_MS = 60 * 60_000;

/** Data civil (UTC) usada na chave de idempotência dos trabalhos diários. */
export function maintenanceDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Enfileira o expurgo diário de arquivos de cada empresa com retenção configurada.
 * A lista vem de função SECURITY DEFINER que devolve só ids; cada trabalho é criado no contexto da empresa,
 * com chave `purge_import_files:AAAA-MM-DD`: chamar várias vezes no mesmo dia não cria outro trabalho.
 */
export async function scheduleMaintenanceJobs(
  deps: Pick<JobDeps, 'pool'>,
  day = maintenanceDay(),
): Promise<{ tenants: number; created: number }> {
  const tenants = await deps.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM maintenance_retention_tenants()');
  let created = 0;
  for (const { tenant_id: tenantId } of tenants.rows) {
    const result = await withContext(deps.pool, { tenantId }, (db) =>
      enqueue(db, {
        tenantId,
        type: PURGE_FILES_JOB_TYPE,
        payload: { day },
        idempotencyKey: `purge_import_files:${day}`,
      }),
    );
    if (result.created) created += 1;
  }
  return { tenants: tenants.rows.length, created };
}
