import pg from 'pg';
import { writeAudit } from '../audit/audit';
import { findTenantBySlug, ownerClient, parentsFirst, tenantTables, TenantOpsError, uuidLiteral } from './tenant-data';

export interface PurgeTenantOptions {
  /** Papel dono do esquema (MIGRATION_DATABASE_URL): só ele pode desabilitar os gatilhos de proteção. */
  connectionString: string;
  slug: string;
  /** Deve repetir o slug. */
  confirm: string;
  log?: (line: string) => void;
}

export interface PurgeTenantResult {
  tenantId: string;
  /** Total de linhas removidas, incluindo a da própria empresa. */
  rows: number;
  tables: number;
}

/** Espera máxima por travas de outras transações antes de desistir (sem prender a instalação). */
const LOCK_TIMEOUT = '30s';

/**
 * Remove definitivamente todos os dados de uma empresa arquivada, em uma única transação: registros de origem
 * e trilha de auditoria inclusive. Os gatilhos que barram DELETE nessas tabelas são desabilitados apenas dentro
 * da transação (ALTER TABLE é transacional e trava as tabelas até o fim) e reabilitados antes do COMMIT.
 * Fica um registro na trilha da plataforma, sem dados da empresa além do identificador.
 */
export async function purgeTenant(options: PurgeTenantOptions): Promise<PurgeTenantResult> {
  const log = options.log ?? (() => undefined);
  if (options.confirm !== options.slug) {
    throw new TenantOpsError('Para eliminar, repita o slug da empresa em --confirm.');
  }
  const client = await ownerClient(options.connectionString);
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    const tenant = await findTenantBySlug(client, options.slug, true);
    if (tenant.status !== 'archived') {
      throw new TenantOpsError(
        `A empresa "${tenant.slug}" está "${tenant.status}". Só empresas arquivadas podem ser eliminadas; arquive-a antes.`,
      );
    }
    const tenantLiteral = uuidLiteral(tenant.id);
    const tables = parentsFirst(await tenantTables(client)).reverse();
    const names = tables.map((table) => table.name);

    // Gatilhos que disparam em DELETE (proteção de origem e da trilha). Bit 8 de tgtype = DELETE.
    const guards = await client.query<{ table: string; trigger: string }>(
      `SELECT c.relname AS table, t.tgname AS trigger
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY ($1::text[])
          AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND (t.tgtype & 8) <> 0
        ORDER BY c.relname, t.tgname`,
      [names],
    );
    const alter = async (action: 'DISABLE' | 'ENABLE') => {
      for (const guard of guards.rows) {
        await client.query(
          `ALTER TABLE ${pg.escapeIdentifier(guard.table)} ${action} TRIGGER ${pg.escapeIdentifier(guard.trigger)}`,
        );
      }
    };
    await alter('DISABLE');

    let total = 0;
    for (const table of tables) {
      const removed = await client.query(`DELETE FROM ${pg.escapeIdentifier(table.name)} WHERE tenant_id = ${tenantLiteral}`);
      total += removed.rowCount ?? 0;
    }
    const removedTenant = await client.query(`DELETE FROM tenants WHERE id = ${tenantLiteral}`);
    total += removedTenant.rowCount ?? 0;
    await alter('ENABLE');

    // Confere pelo catálogo que nada restou antes de confirmar.
    for (const name of names) {
      const left = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${pg.escapeIdentifier(name)} WHERE tenant_id = ${tenantLiteral}`,
      );
      if ((left.rows[0]?.n ?? 0) > 0) throw new TenantOpsError(`Eliminação incompleta na tabela ${name}; nada foi alterado.`);
    }

    await writeAudit(client, {
      tenantId: null,
      actor: { type: 'system', id: null, label: 'cli tenant:purge' },
      action: 'platform.tenant_purged',
      entityType: 'tenant',
      entityId: tenant.id,
      summary: 'Dados de uma empresa arquivada eliminados definitivamente',
      metadata: { rows: total, tables: names.length + 1 },
    });
    await client.query('COMMIT');
    log(`Empresa ${tenant.id} eliminada: ${total} registro(s) em ${names.length + 1} tabela(s).`);
    return { tenantId: tenant.id, rows: total, tables: names.length + 1 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
