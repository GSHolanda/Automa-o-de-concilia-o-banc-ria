import { resolveEnabledModules, type ModuleKey } from '@concilia/core';
import type { Db } from '../../db/context';

export interface PlanLimits {
  maxUsers: number | null;
  maxBankAccounts: number | null;
  maxMonthlyTransactions: number | null;
}

/** O que a empresa pode usar agora: plano, situação da licença, limites e módulos ativos. */
export interface Entitlements {
  planCode: string | null;
  planName: string | null;
  licenseStatus: string | null;
  validUntil: string | null;
  /** Em modo somente leitura, escritas são recusadas; consultas e exportações continuam. */
  readOnly: boolean;
  readOnlyReason: string | null;
  limits: PlanLimits;
  planModules: string[];
  modules: ModuleKey[];
}

function limit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function loadEntitlements(db: Db, tenantId: string): Promise<Entitlements> {
  const license = await db.query<{
    tenant_status: string;
    plan_code: string | null;
    plan_name: string | null;
    status: string | null;
    valid_until: string | null;
    expired: boolean | null;
    limits: Record<string, unknown> | null;
    limits_override: Record<string, unknown> | null;
    modules: string[] | null;
  }>(
    `SELECT t.status AS tenant_status, l.plan_code, p.name AS plan_name, l.status,
            to_char(l.valid_until, 'YYYY-MM-DD') AS valid_until,
            (l.valid_until IS NOT NULL AND l.valid_until < current_date) AS expired,
            p.limits, l.limits_override, p.modules
       FROM tenants t
       LEFT JOIN tenant_licenses l ON l.tenant_id = t.id
       LEFT JOIN plans p ON p.code = l.plan_code
      WHERE t.id = $1`,
    [tenantId],
  );
  const row = license.rows[0];
  const modules = await db.query<{ module_key: string; enabled: boolean }>(
    'SELECT module_key, enabled FROM tenant_modules WHERE tenant_id = $1',
    [tenantId],
  );

  let readOnlyReason: string | null = null;
  if (!row || row.plan_code === null) readOnlyReason = 'a empresa não tem licença registrada';
  else if (row.tenant_status === 'suspended') readOnlyReason = 'a empresa está suspensa';
  else if (row.tenant_status === 'archived') readOnlyReason = 'a empresa está arquivada';
  else if (row.status === 'suspended') readOnlyReason = 'a licença está suspensa';
  else if (row.status === 'canceled') readOnlyReason = 'a licença foi cancelada';
  else if (row.expired) readOnlyReason = `a licença venceu em ${row.valid_until}`;

  const merged = { ...(row?.limits ?? {}), ...(row?.limits_override ?? {}) };
  const planModules = row?.modules ?? [];
  return {
    planCode: row?.plan_code ?? null,
    planName: row?.plan_name ?? null,
    licenseStatus: row?.status ?? null,
    validUntil: row?.valid_until ?? null,
    readOnly: readOnlyReason !== null,
    readOnlyReason,
    limits: {
      maxUsers: limit(merged.maxUsers),
      maxBankAccounts: limit(merged.maxBankAccounts),
      maxMonthlyTransactions: limit(merged.maxMonthlyTransactions),
    },
    planModules,
    modules: resolveEnabledModules(
      planModules,
      modules.rows.map((entry) => ({ key: entry.module_key, enabled: entry.enabled })),
    ),
  };
}
