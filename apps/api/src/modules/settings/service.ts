import {
  mergeTenantSettings,
  parseTenantSettings,
  type TenantSettings,
  type TenantSettingsPatch,
} from '@concilia/core';
import type { Db } from '../../db/context';
import { conflict } from '../../http/errors';

export interface StoredSettings {
  settings: TenantSettings;
  version: number;
}

/** Lê as configurações da empresa. Chaves ausentes recebem o valor padrão do esquema. */
export async function getTenantSettings(db: Db, tenantId: string): Promise<StoredSettings> {
  const result = await db.query<{ data: unknown; version: number }>(
    'SELECT data, version FROM tenant_settings WHERE tenant_id = $1',
    [tenantId],
  );
  const row = result.rows[0];
  return { settings: parseTenantSettings(row?.data ?? {}), version: row?.version ?? 0 };
}

/**
 * Aplica alteração parcial. `expectedVersion`, quando informado, evita que duas pessoas
 * sobrescrevam alterações uma da outra.
 */
export async function updateTenantSettings(
  db: Db,
  tenantId: string,
  userId: string | null,
  patch: TenantSettingsPatch,
  expectedVersion?: number,
): Promise<{ before: StoredSettings; after: StoredSettings }> {
  const locked = await db.query<{ data: unknown; version: number }>(
    'SELECT data, version FROM tenant_settings WHERE tenant_id = $1 FOR UPDATE',
    [tenantId],
  );
  const row = locked.rows[0];
  const before: StoredSettings = { settings: parseTenantSettings(row?.data ?? {}), version: row?.version ?? 0 };
  if (expectedVersion !== undefined && expectedVersion !== before.version) {
    throw conflict('As configurações foram alteradas por outra pessoa. Recarregue e tente de novo.', 'stale_version');
  }
  const settings = mergeTenantSettings(before.settings, patch);
  const saved = await db.query<{ version: number }>(
    `INSERT INTO tenant_settings (tenant_id, data, version, updated_by, updated_at)
     VALUES ($1, $2, 1, $3, now())
     ON CONFLICT (tenant_id) DO UPDATE
       SET data = EXCLUDED.data, version = tenant_settings.version + 1,
           updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING version`,
    [tenantId, JSON.stringify(settings), userId],
  );
  return { before, after: { settings, version: saved.rows[0]!.version } };
}
