import type { JobHandler } from '../../jobs/types';
import { getTenantSettings } from '../settings/service';

export interface PurgeFilesResult {
  retentionDays: number | null;
  purged: number;
  cutoff: string | null;
}

/**
 * Expurgo de arquivos originais (`maintenance.purge_import_files`). Remove de `import_files` os arquivos
 * de lotes processados há mais dias que `imports.originalFileRetentionDays`. O lote, o hash e as
 * estatísticas ficam; o lote recebe `file_purged_at`. Idempotente: uma segunda execução não acha nada.
 */
export const purgeImportFilesHandler: JobHandler = {
  run: async ({ db, tenantId, audit }): Promise<PurgeFilesResult> => {
    const { settings } = await getTenantSettings(db, tenantId);
    const days = settings.imports.originalFileRetentionDays;
    if (days === null) return { retentionDays: null, purged: 0, cutoff: null };

    const cutoff = await db.query<{ cutoff: Date }>('SELECT now() - make_interval(days => $1) AS cutoff', [days]);
    const limit = cutoff.rows[0]!.cutoff;
    // Trava os lotes vencidos: um reprocessamento concorrente (que zera processed_at) espera ou sai do conjunto.
    const due = await db.query<{ id: string }>(
      `SELECT b.id
         FROM import_batches b
        WHERE b.tenant_id = $1
          AND b.processed_at IS NOT NULL
          AND b.processed_at < $2
          AND b.status NOT IN ('queued', 'processing')
          AND EXISTS (SELECT 1 FROM import_files f WHERE f.tenant_id = b.tenant_id AND f.batch_id = b.id)
        ORDER BY b.processed_at
        FOR UPDATE OF b`,
      [tenantId, limit],
    );
    const ids = due.rows.map((row) => row.id);
    if (ids.length === 0) return { retentionDays: days, purged: 0, cutoff: limit.toISOString() };

    const removed = await db.query('DELETE FROM import_files WHERE tenant_id = $1 AND batch_id = ANY ($2::uuid[])', [
      tenantId,
      ids,
    ]);
    await db.query(
      'UPDATE import_batches SET file_purged_at = now() WHERE tenant_id = $1 AND id = ANY ($2::uuid[])',
      [tenantId, ids],
    );
    const purged = removed.rowCount ?? 0;
    await audit({
      action: 'import.files_purged',
      entityType: 'tenant',
      entityId: tenantId,
      summary: `${purged} arquivo(s) original(is) expurgado(s) pela retenção de ${days} dias`,
      metadata: { count: purged, retentionDays: days, cutoff: limit.toISOString() },
    });
    return { retentionDays: days, purged, cutoff: limit.toISOString() };
  },
};
