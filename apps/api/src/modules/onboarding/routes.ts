import { z } from 'zod';
import { badRequest, notFound } from '../../http/errors';
import { route, type RouteDefinition } from '../../http/route';
import { ONBOARDING_STEP_KEYS, loadOnboarding, markOnboardingStep } from './state';
import { loadTemplate } from './templates';

const publicView = ({ status, steps, canComplete }: Awaited<ReturnType<typeof loadOnboarding>>) => ({
  status,
  steps,
  canComplete,
});

export const routes: RouteDefinition[] = [
  route({
    tags: ['onboarding'],
    auth: 'session',
    permission: 'settings.view',
    method: 'GET',
    url: '/onboarding',
    summary: 'Situação da implantação da empresa',
    handler: async ({ db, tenantId }) => publicView(await loadOnboarding(db, tenantId)),
  }),

  route({
    tags: ['onboarding'],
    auth: 'session',
    permission: 'settings.manage',
    method: 'PUT',
    url: '/onboarding/steps/:key',
    summary: 'Marcar etapa da implantação',
    params: z.object({ key: z.enum(ONBOARDING_STEP_KEYS) }),
    body: z.object({ done: z.boolean() }),
    handler: async ({ db, tenantId, params, body, audit }) => {
      await markOnboardingStep(db, tenantId, params.key, body.done);
      await audit({
        action: 'onboarding.step',
        entityType: 'onboarding',
        entityId: tenantId,
        summary: `Etapa ${params.key} marcada como ${body.done ? 'concluída' : 'pendente'}`,
        after: { step: params.key, done: body.done },
      });
      return publicView(await loadOnboarding(db, tenantId));
    },
  }),

  route({
    tags: ['onboarding'],
    auth: 'session',
    permission: 'settings.manage',
    method: 'POST',
    url: '/onboarding/apply-template',
    summary: 'Aplicar modelo de plano de contas e categorias',
    body: z.object({ template: z.string().trim().min(1).max(80) }),
    handler: async ({ db, tenantId, body, audit }) => {
      const template = await loadTemplate(body.template);
      if (!template) throw notFound('Modelo não encontrado.');

      const ids = new Map<string, string>();
      const existing = await db.query<{ id: string; code: string }>(
        'SELECT id, code FROM chart_accounts WHERE tenant_id = $1',
        [tenantId],
      );
      for (const row of existing.rows) ids.set(row.code, row.id);

      const counts = { accountsCreated: 0, accountsExisting: 0, categoriesCreated: 0, categoriesExisting: 0 };
      for (const account of template.accounts) {
        if (ids.has(account.code)) {
          counts.accountsExisting += 1;
          continue;
        }
        const parentId = account.parent ? ids.get(account.parent) : null;
        if (account.parent && !parentId) {
          throw badRequest(`Modelo inválido: conta pai ${account.parent} não encontrada.`, 'invalid_template');
        }
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO chart_accounts (tenant_id, code, name, account_type, parent_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [tenantId, account.code, account.name, account.type, parentId ?? null],
        );
        ids.set(account.code, inserted.rows[0]!.id);
        counts.accountsCreated += 1;
      }
      for (const category of template.categories) {
        const accountId = category.account ? ids.get(category.account) : null;
        if (category.account && !accountId) {
          throw badRequest(`Modelo inválido: conta ${category.account} não encontrada.`, 'invalid_template');
        }
        const inserted = await db.query(
          `INSERT INTO categories (tenant_id, code, name, kind, account_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, code) DO NOTHING`,
          [tenantId, category.code, category.name, category.kind, accountId ?? null],
        );
        if ((inserted.rowCount ?? 0) > 0) counts.categoriesCreated += 1;
        else counts.categoriesExisting += 1;
      }
      await audit({
        action: 'onboarding.template_applied',
        entityType: 'onboarding',
        entityId: tenantId,
        summary: `Modelo ${body.template} aplicado`,
        metadata: { template: body.template, ...counts },
      });
      await markOnboardingStep(db, tenantId, 'chart', true);
      return { template: body.template, ...counts };
    },
  }),

  route({
    tags: ['onboarding'],
    auth: 'session',
    permission: 'settings.manage',
    method: 'POST',
    url: '/onboarding/complete',
    summary: 'Concluir a implantação e ativar a empresa',
    handler: async ({ db, tenantId, audit }) => {
      const state = await loadOnboarding(db, tenantId);
      if (state.status === 'active') return publicView(state);
      const company = state.steps.find((step) => step.key === 'company');
      const missing: string[] = [];
      if (!company?.done) missing.push('company');
      if (!state.hasBankAccount) missing.push('bank_accounts');
      if (state.status !== 'onboarding' || missing.length > 0) {
        throw badRequest('Faltam etapas obrigatórias: dados da empresa e ao menos uma conta bancária.', 'onboarding_incomplete', {
          missing,
        });
      }
      await db.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [tenantId]);
      await audit({
        action: 'onboarding.completed',
        entityType: 'onboarding',
        entityId: tenantId,
        summary: 'Implantação concluída; empresa ativada',
      });
      return publicView(await loadOnboarding(db, tenantId));
    },
  }),
];
