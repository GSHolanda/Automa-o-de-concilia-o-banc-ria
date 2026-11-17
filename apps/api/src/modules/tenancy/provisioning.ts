import { DEFAULT_CLASSIFICATION_RULES, DEFAULT_TENANT_SETTINGS, MODULES, SYSTEM_ROLES } from '@concilia/core';
import { writeAudit, type AuditActor } from '../../audit/audit';
import type { Config } from '../../config/env';
import type { Db } from '../../db/context';
import { badRequest, conflict } from '../../http/errors';
import { generateTemporaryPassword, hashPassword, passwordProblem } from '../../security/password';

export interface ProvisionInput {
  slug: string;
  legalName: string;
  tradeName: string;
  taxId: string | null;
  planCode: string;
  status?: 'onboarding' | 'active';
  admin: { name: string; email: string; password?: string };
  actor: AuditActor;
  requestId?: string | null;
  ip?: string | null;
}

export interface ProvisionedTenant {
  tenantId: string;
  slug: string;
  adminUserId: string;
  /** Presente apenas quando a senha foi gerada; exibida uma única vez. */
  temporaryPassword: string | null;
}

/** Módulos opcionais ligados em uma empresa nova, quando o plano os inclui. Os demais ficam a cargo da empresa. */
const ENABLED_BY_DEFAULT = new Set(['transfers', 'grouping']);

const DEFAULT_CATEGORIES = [
  { code: 'TARIFAS', name: 'Tarifas bancárias', kind: 'fee' },
  { code: 'IMPOSTOS', name: 'Impostos sobre operações financeiras', kind: 'tax' },
  { code: 'JUROS', name: 'Juros e encargos', kind: 'interest' },
  { code: 'TRANSFERENCIAS', name: 'Transferências entre contas', kind: 'transfer' },
] as const;

export const DEFAULT_REPORT_TEMPLATES = [
  {
    name: 'Itens — padrão',
    kind: 'items',
    config: {
      title: 'Itens de conciliação',
      columns: ['date', 'description', 'document', 'amount', 'status', 'kind', 'account'],
      footer: '',
    },
  },
  {
    name: 'Resumo — padrão',
    kind: 'summary',
    config: { title: 'Relatório de conciliação bancária', includePending: true, includeDivergent: true, footer: '' },
  },
] as const;

/**
 * Cria uma empresa pronta para uso: licença, módulos, papéis, configurações padrão,
 * categorias e regras iniciais, modelos de relatório e o primeiro administrador.
 * Deve ser chamada em transação com contexto de plataforma.
 */
export async function provisionTenant(db: Db, config: Config, input: ProvisionInput): Promise<ProvisionedTenant> {
  if (config.deploymentMode === 'single') {
    const existing = await db.query<{ total: number }>('SELECT count(*)::int AS total FROM tenants');
    if ((existing.rows[0]?.total ?? 0) > 0) {
      throw conflict(
        'Esta instalação é dedicada a uma única empresa (DEPLOYMENT_MODE=single) e já possui uma.',
        'single_tenant',
      );
    }
  }

  const plan = await db.query<{ modules: string[] }>('SELECT modules FROM plans WHERE code = $1 AND active', [
    input.planCode,
  ]);
  if (plan.rowCount === 0) throw badRequest(`Plano "${input.planCode}" não existe ou está inativo.`, 'invalid_plan');

  const email = input.admin.email.trim().toLowerCase();
  const temporaryPassword = input.admin.password ? null : generateTemporaryPassword();
  const password = input.admin.password ?? (temporaryPassword as string);
  const problem = passwordProblem(password, { minLength: DEFAULT_TENANT_SETTINGS.security.passwordMinLength }, email);
  if (problem) throw badRequest(problem, 'weak_password');

  const tenant = await db.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, trade_name, tax_id, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.slug, input.legalName, input.tradeName, input.taxId, input.status ?? 'onboarding'],
  );
  const tenantId = tenant.rows[0]!.id;

  // A partir daqui as inserções são da empresa recém-criada.
  await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

  await db.query(`INSERT INTO tenant_licenses (tenant_id, plan_code, status) VALUES ($1, $2, 'trial')`, [
    tenantId,
    input.planCode,
  ]);

  const planModules = new Set(plan.rows[0]!.modules);
  for (const module of MODULES) {
    if (module.required || !planModules.has(module.key)) continue;
    await db.query(`INSERT INTO tenant_modules (tenant_id, module_key, enabled) VALUES ($1, $2, $3)`, [
      tenantId,
      module.key,
      ENABLED_BY_DEFAULT.has(module.key),
    ]);
  }

  let adminRoleId = '';
  for (const role of SYSTEM_ROLES) {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO roles (tenant_id, key, name, description, is_system, permissions)
       VALUES ($1, $2, $3, $4, true, $5) RETURNING id`,
      [tenantId, role.key, role.name, role.description, role.permissions],
    );
    if (role.key === 'admin') adminRoleId = inserted.rows[0]!.id;
  }

  await db.query(`INSERT INTO tenant_settings (tenant_id, data) VALUES ($1, $2)`, [
    tenantId,
    JSON.stringify(DEFAULT_TENANT_SETTINGS),
  ]);

  const categoryByKind = new Map<string, string>();
  for (const category of DEFAULT_CATEGORIES) {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO categories (tenant_id, code, name, kind) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, category.code, category.name, category.kind],
    );
    categoryByKind.set(category.kind, inserted.rows[0]!.id);
  }
  const categoryForKind: Record<string, string> = { internal_transfer: 'transfer' };
  for (const rule of DEFAULT_CLASSIFICATION_RULES) {
    await db.query(
      `INSERT INTO classification_rules
         (tenant_id, name, priority, match_type, pattern, applies_to, direction, result_kind, category_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        tenantId,
        rule.name,
        rule.priority,
        rule.matchType,
        rule.pattern,
        rule.appliesTo,
        rule.direction,
        rule.resultKind,
        categoryByKind.get(categoryForKind[rule.resultKind] ?? rule.resultKind) ?? null,
      ],
    );
  }

  for (const template of DEFAULT_REPORT_TEMPLATES) {
    await db.query(
      `INSERT INTO report_templates (tenant_id, name, kind, config, is_default) VALUES ($1, $2, $3, $4, true)`,
      [tenantId, template.name, template.kind, JSON.stringify(template.config)],
    );
  }

  const user = await db.query<{ id: string }>(
    `INSERT INTO users (tenant_id, role_id, email, name, password_hash, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      tenantId,
      adminRoleId,
      email,
      input.admin.name.trim(),
      await hashPassword(password, config.passwordScryptCost),
      temporaryPassword !== null,
    ],
  );
  const adminUserId = user.rows[0]!.id;

  const common = { actor: input.actor, requestId: input.requestId ?? null, ip: input.ip ?? null };
  await writeAudit(db, {
    ...common,
    tenantId,
    action: 'tenant.provisioned',
    entityType: 'tenant',
    entityId: tenantId,
    summary: `Empresa "${input.tradeName}" criada no plano ${input.planCode}`,
    after: { slug: input.slug, planCode: input.planCode, adminEmail: email },
  });
  await writeAudit(db, {
    ...common,
    tenantId: null,
    action: 'platform.tenant_created',
    entityType: 'tenant',
    entityId: tenantId,
    summary: `Empresa "${input.tradeName}" (${input.slug}) criada`,
    after: { slug: input.slug, planCode: input.planCode },
  });

  return { tenantId, slug: input.slug, adminUserId, temporaryPassword };
}

export async function createPlatformAdmin(
  db: Db,
  config: Config,
  input: { name: string; email: string; password: string },
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const problem = passwordProblem(input.password, { minLength: 12 }, email);
  if (problem) throw badRequest(problem, 'weak_password');
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (tenant_id, role_id, email, name, password_hash, is_platform_admin)
     VALUES (NULL, NULL, $1, $2, $3, true) RETURNING id`,
    [email, input.name.trim(), await hashPassword(input.password, config.passwordScryptCost)],
  );
  await writeAudit(db, {
    tenantId: null,
    actor: { type: 'system', id: null, label: 'cli' },
    action: 'platform.admin_created',
    entityType: 'user',
    entityId: user.rows[0]!.id,
    summary: `Operador da plataforma ${email} criado`,
  });
  return user.rows[0]!.id;
}
