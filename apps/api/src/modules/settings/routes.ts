import { MODULES, canEnableModule, tenantSettingsPatchSchema } from '@concilia/core';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../../http/errors';
import { route, type RouteDefinition } from '../../http/route';
import { markOnboardingStep } from '../onboarding/state';
import { getTenantSettings, updateTenantSettings } from './service';

/** O logotipo embutido é grande: a auditoria registra só que existe. */
function forAudit(settings: Record<string, unknown>): Record<string, unknown> {
  const branding = settings.branding as Record<string, unknown> | undefined;
  if (!branding) return settings;
  return { ...settings, branding: { ...branding, logoDataUrl: branding.logoDataUrl ? '[imagem]' : null } };
}

const companyPatch = z.object({
  legalName: z.string().trim().min(1).max(200).optional(),
  tradeName: z.string().trim().min(1).max(200).optional(),
  taxId: z
    .string()
    .trim()
    .nullable()
    .optional()
    .transform((value) => (typeof value === 'string' ? value.replace(/\D/g, '') : value))
    .refine((value) => value === undefined || value === null || value === '' || /^([0-9]{11}|[0-9]{14})$/.test(value), {
      message: 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).',
    }),
});

interface CompanyRow {
  id: string;
  slug: string;
  legal_name: string;
  trade_name: string;
  tax_id: string | null;
  status: string;
}

const companyView = (row: CompanyRow) => ({
  id: row.id,
  slug: row.slug,
  legalName: row.legal_name,
  tradeName: row.trade_name,
  taxId: row.tax_id,
  status: row.status,
});

export const routes: RouteDefinition[] = [
  route({
    tags: ['configuração'],
    auth: 'session',
    permission: 'settings.view',
    method: 'GET',
    url: '/settings',
    summary: 'Ler configurações da empresa',
    handler: async ({ db, tenantId }) => getTenantSettings(db, tenantId),
  }),

  route({
    tags: ['configuração'],
    auth: 'session',
    permission: 'settings.manage',
    method: 'PUT',
    url: '/settings',
    summary: 'Alterar configurações da empresa',
    body: z.object({ patch: tenantSettingsPatchSchema, version: z.number().int().min(0).optional() }),
    handler: async ({ db, tenantId, auth, body, audit, entitlements }) => {
      if (body.patch.approvals?.enabled === true && !(await entitlements()).modules.includes('approvals')) {
        throw new AppError(403, 'module_disabled', 'O módulo de aprovações não está habilitado para a empresa.', {
          module: 'approvals',
        });
      }
      const { before, after } = await updateTenantSettings(db, tenantId, auth.userId, body.patch, body.version);
      await audit({
        action: 'settings.updated',
        entityType: 'settings',
        entityId: tenantId,
        summary: 'Configurações da empresa alteradas',
        before: { version: before.version, settings: forAudit(before.settings) },
        after: { version: after.version, settings: forAudit(after.settings) },
        metadata: { sections: Object.keys(body.patch) },
      });
      if (body.patch.branding) await markOnboardingStep(db, tenantId, 'branding', true);
      return after;
    },
  }),

  route({
    tags: ['configuração'],
    auth: 'session',
    permission: null,
    method: 'GET',
    url: '/company',
    summary: 'Dados da empresa',
    handler: async ({ db, tenantId }) => {
      const result = await db.query<CompanyRow>(
        'SELECT id, slug, legal_name, trade_name, tax_id, status FROM tenants WHERE id = $1',
        [tenantId],
      );
      if (!result.rows[0]) throw notFound('Empresa não encontrada.');
      return companyView(result.rows[0]);
    },
  }),

  route({
    tags: ['configuração'],
    auth: 'session',
    permission: 'settings.manage',
    method: 'PATCH',
    url: '/company',
    summary: 'Alterar dados da empresa',
    body: companyPatch,
    handler: async ({ db, tenantId, body, audit }) => {
      const current = await db.query<CompanyRow>(
        'SELECT id, slug, legal_name, trade_name, tax_id, status FROM tenants WHERE id = $1 FOR UPDATE',
        [tenantId],
      );
      const before = current.rows[0];
      if (!before) throw notFound('Empresa não encontrada.');
      const taxId = body.taxId === undefined ? before.tax_id : body.taxId === '' ? null : body.taxId;
      const updated = await db.query<CompanyRow>(
        `UPDATE tenants SET legal_name = $2, trade_name = $3, tax_id = $4 WHERE id = $1
         RETURNING id, slug, legal_name, trade_name, tax_id, status`,
        [tenantId, body.legalName ?? before.legal_name, body.tradeName ?? before.trade_name, taxId],
      );
      const after = companyView(updated.rows[0]!);
      await audit({
        action: 'company.updated',
        entityType: 'company',
        entityId: tenantId,
        summary: 'Dados da empresa alterados',
        before: companyView(before),
        after,
      });
      await markOnboardingStep(db, tenantId, 'company', true);
      return after;
    },
  }),

  route({
    tags: ['configuração'],
    auth: 'session',
    permission: null,
    method: 'GET',
    url: '/modules',
    summary: 'Catálogo de módulos e situação na empresa',
    handler: async ({ entitlements }) => {
      const current = await entitlements();
      return {
        items: MODULES.map((module) => ({
          key: module.key,
          name: module.name,
          description: module.description,
          required: module.required,
          inPlan: module.required || current.planModules.includes(module.key),
          enabled: current.modules.includes(module.key),
          externalDependency: 'externalDependency' in module ? module.externalDependency : null,
        })),
      };
    },
  }),

  route({
    tags: ['configuração'],
    auth: 'session',
    permission: 'modules.manage',
    method: 'PUT',
    url: '/modules/:key',
    summary: 'Habilitar ou desabilitar um módulo',
    params: z.object({ key: z.string().max(80) }),
    body: z.object({ enabled: z.boolean() }),
    handler: async ({ db, tenantId, auth, params, body, audit, entitlements }) => {
      const module = MODULES.find((entry) => entry.key === params.key);
      if (!module) throw notFound('Módulo não encontrado.');
      const current = await entitlements();
      if (body.enabled ? !canEnableModule(module.key, current.planModules) : module.required) {
        throw forbidden(
          module.required
            ? 'Módulos obrigatórios não podem ser alterados.'
            : 'O plano da empresa não inclui este módulo.',
          'module_not_in_plan',
        );
      }
      const wasEnabled = current.modules.some((key) => key === module.key);
      await db.query(
        `INSERT INTO tenant_modules (tenant_id, module_key, enabled, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, module_key)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by`,
        [tenantId, module.key, body.enabled, auth.userId],
      );
      await audit({
        action: body.enabled ? 'module.enabled' : 'module.disabled',
        entityType: 'module',
        entityId: null,
        summary: `Módulo ${module.name} ${body.enabled ? 'habilitado' : 'desabilitado'}`,
        before: { key: module.key, enabled: wasEnabled },
        after: { key: module.key, enabled: body.enabled },
      });
      return {
        key: module.key,
        name: module.name,
        description: module.description,
        required: module.required,
        inPlan: true,
        enabled: body.enabled,
        externalDependency: 'externalDependency' in module ? module.externalDependency : null,
      };
    },
  }),

  route({
    tags: ['configuração'],
    auth: 'session',
    permission: null,
    method: 'GET',
    url: '/license',
    summary: 'Plano, licença e limites da empresa',
    handler: async ({ entitlements }) => entitlements(),
  }),
];
