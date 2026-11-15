import { ITEM_KINDS, MATCH_TYPES, importProfileConfigSchema } from '@concilia/core';
import { z } from 'zod';
import { forbidden } from '../../http/errors';
import { registryRoutes, type RegistryDefinition } from './crud';

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const active = z.boolean().optional();
const ORG_KINDS = ['unit', 'department', 'cost_center'] as const;

const orgNodes: RegistryDefinition = {
  path: '/org-nodes',
  table: 'org_nodes',
  entity: 'org_node',
  label: 'unidade/departamento/centro de custo',
  shape: {
    kind: z.enum(ORG_KINDS),
    code: text(40),
    name: text(120),
    parentId: z.uuid().nullable().optional(),
    active,
  },
  filters: { kind: z.enum(ORG_KINDS) },
  orderBy: 'kind, code',
  nameField: 'name',
  hierarchical: true,
};

const chartAccounts: RegistryDefinition = {
  path: '/chart-accounts',
  table: 'chart_accounts',
  entity: 'chart_account',
  label: 'conta contábil',
  shape: {
    code: text(40),
    name: text(160),
    accountType: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
    parentId: z.uuid().nullable().optional(),
    active,
  },
  orderBy: 'code',
  nameField: 'name',
  hierarchical: true,
};

const categories: RegistryDefinition = {
  path: '/categories',
  table: 'categories',
  entity: 'category',
  label: 'categoria',
  shape: {
    code: text(40),
    name: text(120),
    kind: z.enum(['fee', 'tax', 'interest', 'transfer', 'revenue', 'expense', 'other']),
    accountId: z.uuid().nullable().optional(),
    active,
  },
  orderBy: 'code',
  nameField: 'name',
};

const bankAccounts: RegistryDefinition = {
  path: '/bank-accounts',
  table: 'bank_accounts',
  entity: 'bank_account',
  label: 'conta bancária',
  shape: {
    name: text(120),
    bankCode: z.string().regex(/^[0-9]{1,8}$/, 'Use apenas dígitos.').nullable().optional(),
    bankName: optionalText(120),
    branch: optionalText(40),
    accountNumber: optionalText(40),
    currency: z.string().regex(/^[A-Z]{3}$/, 'Use o código da moeda, por exemplo BRL.').optional(),
    unitId: z.uuid().nullable().optional(),
    ledgerAccountId: z.uuid().nullable().optional(),
    externalRef: optionalText(120),
    active,
  },
  orderBy: 'name',
  nameField: 'name',
  // O limite do plano vale para contas ativas, ao criar ou reativar.
  beforeWrite: async ({ db, tenantId, mode, existing, data, entitlements }) => {
    const activating = mode === 'create' ? data.active !== false : data.active === true && existing?.active === false;
    if (!activating) return;
    const max = (await entitlements()).limits.maxBankAccounts;
    if (max === null) return;
    const result = await db.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM bank_accounts WHERE tenant_id = $1 AND active',
      [tenantId],
    );
    if ((result.rows[0]?.total ?? 0) >= max) {
      throw forbidden(`O plano permite até ${max} contas bancárias ativas.`, 'limit_reached');
    }
  },
};

const classificationRules: RegistryDefinition = {
  path: '/classification-rules',
  table: 'classification_rules',
  entity: 'classification_rule',
  label: 'regra de classificação',
  shape: {
    name: text(120),
    priority: z.number().int().min(0).max(10000).optional(),
    matchType: z.enum(MATCH_TYPES),
    pattern: text(200),
    appliesTo: z.enum(['bank', 'ledger', 'both']).optional(),
    direction: z.enum(['any', 'credit', 'debit']).optional(),
    resultKind: z.enum(ITEM_KINDS),
    categoryId: z.uuid().nullable().optional(),
    active,
  },
  orderBy: 'priority, name',
  nameField: 'name',
};

const importProfiles: RegistryDefinition = {
  path: '/import-profiles',
  table: 'import_profiles',
  entity: 'import_profile',
  label: 'perfil de importação',
  shape: {
    name: text(120),
    sourceKind: z.enum(['bank', 'ledger']),
    fileFormat: z.enum(['csv', 'xlsx']),
    config: importProfileConfigSchema,
    active,
  },
  jsonFields: ['config'],
  orderBy: 'name',
  nameField: 'name',
};

const reportTemplates: RegistryDefinition = {
  path: '/report-templates',
  table: 'report_templates',
  entity: 'report_template',
  label: 'modelo de relatório',
  shape: {
    name: text(120),
    kind: z.enum(['items', 'summary']),
    config: z.record(z.string(), z.unknown()).optional(),
    isDefault: z.boolean().optional(),
  },
  jsonFields: ['config'],
  orderBy: 'name',
  nameField: 'name',
  // Só um modelo padrão por tipo.
  beforeWrite: async ({ db, tenantId, existing, data }) => {
    if (data.isDefault !== true) return;
    const kind = (data.kind ?? existing?.kind) as string;
    await db.query(
      `UPDATE report_templates SET is_default = false
        WHERE tenant_id = $1 AND kind = $2 AND is_default AND id IS DISTINCT FROM $3::uuid`,
      [tenantId, kind, existing?.id ?? null],
    );
  },
};

export const registries: RegistryDefinition[] = [
  orgNodes,
  chartAccounts,
  categories,
  bankAccounts,
  classificationRules,
  importProfiles,
  reportTemplates,
];

export const routes = registries.flatMap((definition) => registryRoutes(definition));
