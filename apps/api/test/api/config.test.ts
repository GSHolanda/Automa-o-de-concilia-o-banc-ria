import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, createTenant, loggedIn, userWithRole, type ApiClient, type TestTenant } from '../helpers/app';
import { closePools, ownerPool } from '../helpers/db';

let app: FastifyInstance;
let tenantA: TestTenant;
let tenantB: TestTenant;
let a: ApiClient;
let b: ApiClient;

beforeAll(async () => {
  app = await buildTestApp();
  tenantA = await createTenant();
  tenantB = await createTenant();
  a = await loggedIn(app, tenantA.adminEmail);
  b = await loggedIn(app, tenantB.adminEmail);
});

afterAll(async () => {
  await app.close();
  await closePools();
});

const profileConfig = { amountMode: 'signed', columns: { date: 'Data', description: ['Histórico'], amount: 'Valor' } };

describe('configurações', () => {
  it('lê, altera com controle de versão e audita', async () => {
    const t = await createTenant();
    const c = await loggedIn(app, t.adminEmail);
    const first = await c.get('/settings');
    expect(first.status).toBe(200);
    expect(first.body.settings.branding.primaryColor).toBe('#0b5cab');

    const saved = await c.put('/settings', { patch: { branding: { primaryColor: '#112233' } }, version: first.body.version });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.branding.primaryColor).toBe('#112233');
    expect(saved.body.version).toBe(first.body.version + 1);

    const stale = await c.put('/settings', { patch: { security: { passwordMinLength: 14 } }, version: first.body.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_version');

    const invalid = await c.put('/settings', { patch: { branding: { primaryColor: 'azul' } } });
    expect(invalid.status).toBe(400);

    const audit = await c.get('/audit?action=settings.updated');
    expect(audit.body.items.length).toBeGreaterThan(0);
  });

  it('exige permissão para alterar, mas não para consultar dados básicos', async () => {
    const analyst = await userWithRole(app, a, 'analista');
    expect((await analyst.put('/settings', { patch: {} })).status).toBe(403);
    expect((await analyst.patch('/company', { tradeName: 'Outro' })).status).toBe(403);
    expect((await analyst.post('/categories', { code: 'X', name: 'X', kind: 'other' })).status).toBe(403);
    expect((await analyst.get('/categories')).status).toBe(200);
    expect((await analyst.get('/company')).status).toBe(200);
    expect((await analyst.get('/license')).status).toBe(200);
    expect((await analyst.put('/modules/approvals', { enabled: true })).status).toBe(403);
  });

  it('isola as configurações entre empresas', async () => {
    await a.put('/settings', { patch: { branding: { primaryColor: '#aa0000' } } });
    const other = await b.get('/settings');
    expect(other.body.settings.branding.primaryColor).not.toBe('#aa0000');
  });
});

describe('empresa', () => {
  it('consulta e altera os dados, normalizando o documento', async () => {
    const t = await createTenant();
    const c = await loggedIn(app, t.adminEmail);
    const current = await c.get('/company');
    expect(current.body).toMatchObject({ id: t.tenantId, slug: t.slug, status: 'active' });

    const changed = await c.patch('/company', { tradeName: 'Nome Fantasia Novo', taxId: '11.222.333/0001-81' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ tradeName: 'Nome Fantasia Novo', taxId: '11222333000181' });

    expect((await c.patch('/company', { taxId: '123' })).status).toBe(400);
    expect((await c.patch('/company', { legalName: '' })).status).toBe(400);
    expect((await c.patch('/company', { taxId: null })).body.taxId).toBeNull();
  });

  it('não expõe nem altera a empresa de outra', async () => {
    await a.patch('/company', { tradeName: 'Somente da A' });
    const other = await b.get('/company');
    expect(other.body.id).toBe(tenantB.tenantId);
    expect(other.body.tradeName).not.toBe('Somente da A');
  });
});

describe('cadastros', () => {
  it('plano de contas e categorias: CRUD, validação, hierarquia e uso', async () => {
    const root = await a.post('/chart-accounts', { code: 'T1', name: 'Ativo teste', accountType: 'asset' });
    expect(root.status).toBe(201);
    const child = await a.post('/chart-accounts', { code: 'T1.1', name: 'Filha', accountType: 'asset', parentId: root.body.id });
    expect(child.status).toBe(201);
    expect(child.body.active).toBe(true);

    expect((await a.post('/chart-accounts', { code: 'T1', name: 'Repetida', accountType: 'asset' })).status).toBe(409);
    expect((await a.post('/chart-accounts', { code: 'T9', name: 'Tipo ruim', accountType: 'xyz' })).status).toBe(400);
    expect((await a.post('/chart-accounts', { name: 'Sem código', accountType: 'asset' })).status).toBe(400);
    expect((await a.post('/chart-accounts', { code: 'T8', name: 'Pai inexistente', accountType: 'asset', parentId: crypto.randomUUID() })).status).toBe(400);

    // ciclo: a raiz não pode ser filha da própria filha
    expect((await a.patch(`/chart-accounts/${root.body.id}`, { parentId: child.body.id })).status).toBe(400);
    expect((await a.patch(`/chart-accounts/${root.body.id}`, { parentId: root.body.id })).status).toBe(400);

    const category = await a.post('/categories', { code: 'CT1', name: 'Categoria teste', kind: 'fee', accountId: child.body.id });
    expect(category.status).toBe(201);
    expect((await a.get(`/categories/${category.body.id}`)).body.accountId).toBe(child.body.id);

    const updated = await a.patch(`/categories/${category.body.id}`, { name: 'Categoria renomeada', active: false });
    expect(updated.body).toMatchObject({ name: 'Categoria renomeada', active: false, code: 'CT1' });

    // conta em uso não é excluída
    const blocked = await a.delete(`/chart-accounts/${child.body.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('in_use');

    expect((await a.delete(`/categories/${category.body.id}`)).status).toBe(204);
    expect((await a.delete(`/chart-accounts/${child.body.id}`)).status).toBe(204);
    expect((await a.get(`/categories/${category.body.id}`)).status).toBe(404);

    const list = await a.get('/categories');
    expect(Array.isArray(list.body.items)).toBe(true);
  });

  it('estrutura organizacional com filtro por tipo', async () => {
    const unit = await a.post('/org-nodes', { kind: 'unit', code: 'U1', name: 'Matriz' });
    const center = await a.post('/org-nodes', { kind: 'cost_center', code: 'CC1', name: 'Administração', parentId: unit.body.id });
    expect(unit.status).toBe(201);
    expect(center.status).toBe(201);
    const onlyUnits = await a.get('/org-nodes?kind=unit');
    expect(onlyUnits.body.items.every((item: { kind: string }) => item.kind === 'unit')).toBe(true);
    expect(onlyUnits.body.items.map((item: { id: string }) => item.id)).toContain(unit.body.id);
    expect((await a.get('/org-nodes?kind=outro')).status).toBe(400);
    expect((await a.delete(`/org-nodes/${unit.body.id}`)).status).toBe(409);
  });

  it('contas bancárias: validação e conta em uso', async () => {
    const created = await a.post('/bank-accounts', { name: 'Conta principal', bankCode: '001', branch: '1234', accountNumber: '56789-0' });
    expect(created.status).toBe(201);
    expect(created.body.currency).toBe('BRL');
    expect((await a.post('/bank-accounts', { name: 'Conta principal' })).status).toBe(409);
    expect((await a.post('/bank-accounts', { name: 'Banco ruim', bankCode: 'abc' })).status).toBe(400);
    expect((await a.patch(`/bank-accounts/${created.body.id}`, { externalRef: 'CX-01' })).body.externalRef).toBe('CX-01');
  });

  it('respeita o limite de contas bancárias do plano', async () => {
    const t = await createTenant({ plan: 'essencial' });
    const c = await loggedIn(app, t.adminEmail);
    for (let index = 1; index <= 3; index += 1) {
      expect((await c.post('/bank-accounts', { name: `Conta ${index}` })).status).toBe(201);
    }
    const over = await c.post('/bank-accounts', { name: 'Conta 4' });
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('limit_reached');
    // conta inativa não ocupa o limite; reativá-la, sim
    const list = await c.get('/bank-accounts');
    await c.patch(`/bank-accounts/${list.body.items[0].id}`, { active: false });
    const fourth = await c.post('/bank-accounts', { name: 'Conta 4' });
    expect(fourth.status).toBe(201);
    expect((await c.patch(`/bank-accounts/${list.body.items[0].id}`, { active: true })).status).toBe(403);
  });

  it('regras de classificação: validação, categoria e ordem por prioridade', async () => {
    const category = await a.post('/categories', { code: 'CT-R', name: 'Categoria da regra', kind: 'fee' });
    const second = await a.post('/classification-rules', {
      name: 'Segunda', priority: 200, matchType: 'contains', pattern: 'TARIFA', resultKind: 'fee', categoryId: category.body.id,
    });
    const first = await a.post('/classification-rules', { name: 'Primeira', priority: 10, matchType: 'equals', pattern: 'IOF', resultKind: 'tax' });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ appliesTo: 'bank', direction: 'any', active: true });
    const list = await a.get('/classification-rules');
    const names = list.body.items.map((item: { name: string }) => item.name);
    expect(names.indexOf('Primeira')).toBeLessThan(names.indexOf('Segunda'));

    expect((await a.post('/classification-rules', { name: 'Ruim', matchType: 'regex', pattern: 'x', resultKind: 'fee' })).status).toBe(400);
    expect((await a.post('/classification-rules', { name: 'Ruim', matchType: 'contains', pattern: 'x', resultKind: 'fee', priority: 99999 })).status).toBe(400);
    expect((await a.post('/classification-rules', { name: 'Ruim', matchType: 'contains', pattern: 'x', resultKind: 'fee', categoryId: crypto.randomUUID() })).status).toBe(400);
    expect((await a.delete(`/categories/${category.body.id}`)).status).toBe(409);
    expect((await a.patch(`/classification-rules/${first.body.id}`, { pattern: 'IOF DIARIO' })).body.pattern).toBe('IOF DIARIO');
    expect((await a.delete(`/classification-rules/${first.body.id}`)).status).toBe(204);
  });

  it('perfis de importação validam a configuração e guardam os padrões', async () => {
    const created = await a.post('/import-profiles', { name: 'Extrato CSV', sourceKind: 'bank', fileFormat: 'csv', config: profileConfig });
    expect(created.status).toBe(201);
    expect(created.body.config).toMatchObject({ delimiter: 'auto', headerRow: 1, amountMode: 'signed' });

    const noAmount = await a.post('/import-profiles', {
      name: 'Sem valor', sourceKind: 'bank', fileFormat: 'csv', config: { amountMode: 'signed', columns: { date: 'Data', description: ['Histórico'] } },
    });
    expect(noAmount.status).toBe(400);
    expect((await a.post('/import-profiles', { name: 'Formato', sourceKind: 'bank', fileFormat: 'pdf', config: profileConfig })).status).toBe(400);

    const patched = await a.patch(`/import-profiles/${created.body.id}`, { config: { ...profileConfig, delimiter: ';' } });
    expect(patched.body.config.delimiter).toBe(';');
    expect((await a.patch(`/import-profiles/${created.body.id}`, { config: { amountMode: 'debit_credit', columns: { date: 'D', description: ['H'] } } })).status).toBe(400);
  });

  it('modelos de relatório: apenas um padrão por tipo', async () => {
    const one = await a.post('/report-templates', { name: 'Itens A', kind: 'items', config: { columns: ['date'] }, isDefault: true });
    const two = await a.post('/report-templates', { name: 'Itens B', kind: 'items', isDefault: true });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect((await a.get(`/report-templates/${one.body.id}`)).body.isDefault).toBe(false);
    expect((await a.get(`/report-templates/${two.body.id}`)).body.isDefault).toBe(true);
    expect((await a.post('/report-templates', { name: 'Tipo', kind: 'outro' })).status).toBe(400);
  });

  it('grava auditoria das escritas, sem vazar entre empresas', async () => {
    const t = await createTenant();
    const c = await loggedIn(app, t.adminEmail);
    const cat = await c.post('/categories', { code: 'AUD', name: 'Auditada', kind: 'other' });
    await c.patch(`/categories/${cat.body.id}`, { name: 'Auditada 2' });
    await c.delete(`/categories/${cat.body.id}`);
    const log = await c.get('/audit?entityType=category');
    const actions = log.body.items.map((item: { action: string }) => item.action);
    expect(actions).toEqual(expect.arrayContaining(['category.created', 'category.updated', 'category.deleted']));
  });
});

describe('isolamento entre empresas', () => {
  const resources: Array<{ path: string; create: Record<string, unknown>; patch: Record<string, unknown> }> = [
    { path: '/org-nodes', create: { kind: 'unit', code: 'ISO', name: 'Unidade isolada' }, patch: { name: 'Invadida' } },
    { path: '/chart-accounts', create: { code: 'ISO', name: 'Conta isolada', accountType: 'asset' }, patch: { name: 'Invadida' } },
    { path: '/categories', create: { code: 'ISO', name: 'Categoria isolada', kind: 'other' }, patch: { name: 'Invadida' } },
    { path: '/bank-accounts', create: { name: 'Conta isolada' }, patch: { name: 'Invadida' } },
    { path: '/classification-rules', create: { name: 'Regra isolada', matchType: 'contains', pattern: 'ISO', resultKind: 'fee' }, patch: { name: 'Invadida' } },
    { path: '/import-profiles', create: { name: 'Perfil isolado', sourceKind: 'bank', fileFormat: 'csv', config: profileConfig }, patch: { name: 'Invadida' } },
    { path: '/report-templates', create: { name: 'Modelo isolado', kind: 'items' }, patch: { name: 'Invadida' } },
  ];

  for (const resource of resources) {
    it(`${resource.path}: a outra empresa recebe 404 e não vê o registro`, async () => {
      const mine = await a.post(resource.path, resource.create);
      expect(mine.status).toBe(201);
      const id = mine.body.id as string;

      expect((await b.get(`${resource.path}/${id}`)).status).toBe(404);
      expect((await b.patch(`${resource.path}/${id}`, resource.patch)).status).toBe(404);
      expect((await b.delete(`${resource.path}/${id}`)).status).toBe(404);
      const list = await b.get(resource.path);
      expect(list.body.items.map((item: { id: string }) => item.id)).not.toContain(id);

      // o registro da dona segue intacto e o mesmo código pode existir na outra empresa
      expect((await a.get(`${resource.path}/${id}`)).body.name).toBe(resource.create.name);
      expect((await b.post(resource.path, resource.create)).status).toBe(201);
    });
  }

  it('referência a registro de outra empresa é recusada', async () => {
    const foreign = await b.post('/chart-accounts', { code: 'EXT', name: 'Conta da B', accountType: 'asset' });
    const response = await a.post('/categories', { code: 'REF', name: 'Referência cruzada', kind: 'other', accountId: foreign.body.id });
    expect(response.status).toBe(400);
  });
});

describe('módulos e licença', () => {
  it('lista o catálogo com a situação de cada módulo', async () => {
    const response = await a.get('/modules');
    expect(response.status).toBe(200);
    const byKey = Object.fromEntries(response.body.items.map((item: { key: string }) => [item.key, item]));
    expect(byKey['core.access']).toMatchObject({ required: true, inPlan: true, enabled: true });
    expect(byKey['ai.assist']).toMatchObject({ required: false, inPlan: true });
    expect(byKey['ai.assist'].externalDependency).toEqual(expect.any(String));
    expect(byKey['approvals']).toHaveProperty('enabled');
  });

  it('CA-24: módulo desabilitado bloqueia o que depende dele', async () => {
    const t = await createTenant();
    const c = await loggedIn(app, t.adminEmail);
    expect((await c.put('/modules/approvals', { enabled: true })).status).toBe(200);
    const on = await c.put('/settings', { patch: { approvals: { enabled: true } } });
    expect(on.status).toBe(200);

    expect((await c.put('/modules/approvals', { enabled: false })).status).toBe(200);
    const mods = await c.get('/modules');
    expect(mods.body.items.find((item: { key: string }) => item.key === 'approvals').enabled).toBe(false);
    expect((await c.get('/license')).body.modules).not.toContain('approvals');

    await c.put('/settings', { patch: { approvals: { enabled: false } } });
    const blocked = await c.put('/settings', { patch: { approvals: { enabled: true } } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('module_disabled');
  });

  it('módulo fora do plano ou obrigatório não pode ser alterado', async () => {
    const t = await createTenant({ plan: 'essencial' });
    const c = await loggedIn(app, t.adminEmail);
    const notInPlan = await c.put('/modules/ai.assist', { enabled: true });
    expect(notInPlan.status).toBe(403);
    expect(notInPlan.body.error.code).toBe('module_not_in_plan');
    expect((await c.put('/modules/core.access', { enabled: false })).status).toBe(403);
    expect((await c.put('/modules/inexistente', { enabled: true })).status).toBe(404);
    expect((await c.put('/modules/transfers', { enabled: true })).status).toBe(200);
  });

  it('a licença mostra plano, limites e módulos ativos', async () => {
    const license = await a.get('/license');
    expect(license.body).toMatchObject({ planCode: 'corporativo', readOnly: false });
    expect(license.body.limits).toHaveProperty('maxBankAccounts');
    const essential = await createTenant({ plan: 'essencial' });
    const c = await loggedIn(app, essential.adminEmail);
    expect((await c.get('/license')).body.limits.maxBankAccounts).toBe(3);
  });

  it('CA-25: licença suspensa bloqueia escritas e mantém leituras', async () => {
    const t = await createTenant();
    const c = await loggedIn(app, t.adminEmail);
    const cat = await c.post('/categories', { code: 'LIC', name: 'Antes da suspensão', kind: 'other' });
    expect(cat.status).toBe(201);

    await ownerPool().query(`UPDATE tenant_licenses SET status = 'suspended' WHERE tenant_id = $1`, [t.tenantId]);

    for (const attempt of [
      () => c.post('/categories', { code: 'LIC2', name: 'Depois', kind: 'other' }),
      () => c.patch(`/categories/${cat.body.id}`, { name: 'Mudou' }),
      () => c.delete(`/categories/${cat.body.id}`),
      () => c.put('/settings', { patch: { branding: { primaryColor: '#010101' } } }),
      () => c.patch('/company', { tradeName: 'Nova' }),
      () => c.put('/modules/transfers', { enabled: false }),
      () => c.post('/bank-accounts', { name: 'Nova conta' }),
    ]) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('license_inactive');
    }

    expect((await c.get('/categories')).status).toBe(200);
    expect((await c.get(`/categories/${cat.body.id}`)).body.name).toBe('Antes da suspensão');
    expect((await c.get('/settings')).status).toBe(200);
    expect((await c.get('/company')).status).toBe(200);
    const license = await c.get('/license');
    expect(license.status).toBe(200);
    expect(license.body).toMatchObject({ readOnly: true, licenseStatus: 'suspended' });

    await ownerPool().query(`UPDATE tenant_licenses SET status = 'active' WHERE tenant_id = $1`, [t.tenantId]);
    expect((await c.post('/categories', { code: 'LIC3', name: 'Reativada', kind: 'other' })).status).toBe(201);
  });
});

describe('onboarding', () => {
  it('conduz a implantação até ativar a empresa', async () => {
    const t = await createTenant({ status: 'onboarding' });
    const c = await loggedIn(app, t.adminEmail);

    const start = await c.get('/onboarding');
    expect(start.status).toBe(200);
    expect(start.body.status).toBe('onboarding');
    expect(start.body.steps.map((step: { key: string }) => step.key)).toEqual([
      'company', 'branding', 'bank_accounts', 'structure', 'chart', 'import_profile', 'rules', 'users',
    ]);
    expect(start.body.canComplete).toBe(false);

    const early = await c.post('/onboarding/complete');
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('onboarding_incomplete');
    expect(early.body.error.details.missing).toEqual(['company', 'bank_accounts']);

    await c.patch('/company', { tradeName: 'Empresa Implantada' });
    const noAccount = await c.post('/onboarding/complete');
    expect(noAccount.body.error.details.missing).toEqual(['bank_accounts']);

    await c.post('/bank-accounts', { name: 'Conta da implantação' });
    const ready = await c.get('/onboarding');
    expect(ready.body.canComplete).toBe(true);
    const step = (key: string) => ready.body.steps.find((entry: { key: string }) => entry.key === key);
    expect(step('company').done).toBe(true);
    expect(step('bank_accounts').done).toBe(true);
    expect(step('chart').done).toBe(false);

    const marked = await c.put('/onboarding/steps/branding', { done: true });
    expect(marked.body.steps.find((entry: { key: string }) => entry.key === 'branding').done).toBe(true);
    expect((await c.put('/onboarding/steps/inexistente', { done: true })).status).toBe(400);

    const done = await c.post('/onboarding/complete');
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('active');
    expect((await c.get('/company')).body.status).toBe('active');
    expect((await c.post('/onboarding/complete')).status).toBe(200);
  });

  it('aplica o modelo de plano de contas de forma idempotente', async () => {
    const t = await createTenant();
    const c = await loggedIn(app, t.adminEmail);
    await c.post('/chart-accounts', { code: '1.1.01', name: 'Caixa próprio', accountType: 'asset' });

    const first = await c.post('/onboarding/apply-template', { template: 'plano-de-contas-basico' });
    expect(first.status).toBe(200);
    expect(first.body.accountsExisting).toBe(1);
    expect(first.body.accountsCreated).toBeGreaterThanOrEqual(20);
    expect(first.body.categoriesCreated).toBeGreaterThan(0);

    const second = await c.post('/onboarding/apply-template', { template: 'plano-de-contas-basico' });
    expect(second.body).toMatchObject({ accountsCreated: 0, categoriesCreated: 0 });
    expect(second.body.accountsExisting).toBe(first.body.accountsCreated + 1);

    const accounts = await c.get('/chart-accounts');
    expect(accounts.body.items.find((item: { code: string }) => item.code === '1.1.01').name).toBe('Caixa próprio');
    const child = accounts.body.items.find((item: { code: string }) => item.code === '1.1.02');
    const parent = accounts.body.items.find((item: { code: string }) => item.code === '1.1');
    expect(child.parentId).toBe(parent.id);
    const categories = await c.get('/categories');
    expect(categories.body.items.find((item: { code: string }) => item.code === 'TARIFA').accountId).not.toBeNull();
    const onboarding = await c.get('/onboarding');
    expect(onboarding.body.steps.find((entry: { key: string }) => entry.key === 'chart').done).toBe(true);

    // não vaza para a outra empresa
    expect((await b.get('/chart-accounts')).body.items.find((item: { code: string }) => item.code === '5.4')).toBeUndefined();
  });

  it('recusa modelo inexistente ou com nome suspeito', async () => {
    expect((await a.post('/onboarding/apply-template', { template: 'nao-existe' })).status).toBe(404);
    expect((await a.post('/onboarding/apply-template', { template: '../package' })).status).toBe(404);
  });

  it('exige permissão de gerenciamento', async () => {
    const auditor = await userWithRole(app, a, 'auditor');
    expect((await auditor.post('/onboarding/complete')).status).toBe(403);
    expect((await auditor.post('/onboarding/apply-template', { template: 'plano-de-contas-basico' })).status).toBe(403);
    expect((await auditor.get('/onboarding')).status).toBe(200);
  });
});
