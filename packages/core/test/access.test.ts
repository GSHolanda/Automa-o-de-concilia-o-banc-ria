import { describe, expect, it } from 'vitest';
import { MODULES, canEnableModule, resolveEnabledModules } from '../src/modules';
import { PERMISSIONS, SYSTEM_ROLES, hasPermission, sanitizePermissions } from '../src/permissions';
import { DEFAULT_TENANT_SETTINGS, approvalRequired, parseTenantSettings } from '../src/settings/schema';

describe('permissões', () => {
  it('concede apenas o que está na lista', () => {
    expect(hasPermission(['imports.view'], 'imports.view')).toBe(true);
    expect(hasPermission(['imports.view'], 'imports.create')).toBe(false);
    expect(hasPermission([], 'dashboard.view')).toBe(false);
  });

  it('descarta permissões desconhecidas e repetidas', () => {
    expect(sanitizePermissions(['imports.view', 'nao.existe', 'imports.view'])).toEqual(['imports.view']);
  });

  it('o papel administrador tem todas as permissões e o auditor nenhuma de escrita', () => {
    const admin = SYSTEM_ROLES.find((role) => role.key === 'admin')!;
    const auditor = SYSTEM_ROLES.find((role) => role.key === 'auditor')!;
    expect([...admin.permissions].sort()).toEqual(Object.keys(PERMISSIONS).sort());
    const writes = ['imports.create', 'reconciliation.run', 'reconciliation.review', 'reconciliation.approve',
      'reconciliation.undo', 'settings.manage', 'users.manage', 'integrations.manage', 'modules.manage'];
    for (const permission of writes) expect(auditor.permissions).not.toContain(permission);
  });

  it('o analista revisa mas não aprova nem desfaz', () => {
    const analyst = SYSTEM_ROLES.find((role) => role.key === 'analista')!;
    expect(analyst.permissions).toContain('reconciliation.review');
    expect(analyst.permissions).not.toContain('reconciliation.approve');
    expect(analyst.permissions).not.toContain('reconciliation.undo');
  });
});

describe('módulos', () => {
  it('módulos obrigatórios estão sempre ativos', () => {
    const enabled = resolveEnabledModules([], []);
    for (const module of MODULES.filter((entry) => entry.required)) expect(enabled).toContain(module.key);
    expect(enabled).not.toContain('approvals');
  });

  it('módulo opcional exige estar no plano e habilitado para a empresa', () => {
    expect(resolveEnabledModules(['approvals'], [])).not.toContain('approvals');
    expect(resolveEnabledModules([], [{ key: 'approvals', enabled: true }])).not.toContain('approvals');
    expect(resolveEnabledModules(['approvals'], [{ key: 'approvals', enabled: true }])).toContain('approvals');
    expect(resolveEnabledModules(['approvals'], [{ key: 'approvals', enabled: false }])).not.toContain('approvals');
  });

  it('só permite habilitar módulo opcional previsto no plano', () => {
    expect(canEnableModule('approvals', ['approvals'])).toBe(true);
    expect(canEnableModule('ai.assist', ['approvals'])).toBe(false);
    expect(canEnableModule('core.reconciliation', [])).toBe(false);
    expect(canEnableModule('nao.existe', ['nao.existe'])).toBe(false);
  });
});

describe('configurações da empresa', () => {
  it('preenche valores padrão para documento vazio', () => {
    expect(parseTenantSettings({})).toEqual(DEFAULT_TENANT_SETTINGS);
    expect(DEFAULT_TENANT_SETTINGS.reconciliation.dateToleranceDays).toBe(2);
  });

  it('preserva o que foi configurado e completa chaves novas', () => {
    const settings = parseTenantSettings({ reconciliation: { dateToleranceDays: 5 }, branding: { primaryColor: '#112233' } });
    expect(settings.reconciliation.dateToleranceDays).toBe(5);
    expect(settings.reconciliation.autoConfirm.byIdentifier).toBe(true);
    expect(settings.branding.primaryColor).toBe('#112233');
    expect(settings.approvals.fourEyes).toBe(true);
  });

  it('recusa valores fora dos limites', () => {
    expect(() => parseTenantSettings({ reconciliation: { dateToleranceDays: 400 } })).toThrow();
    expect(() => parseTenantSettings({ branding: { primaryColor: 'azul' } })).toThrow();
    expect(() => parseTenantSettings({ branding: { logoDataUrl: 'data:image/svg+xml;base64,AAAA' } })).toThrow();
  });

  it('decide quando uma operação exige segunda aprovação', () => {
    const settings = parseTenantSettings({ approvals: { enabled: true } });
    expect(approvalRequired(settings.approvals, { operation: 'manual', hasDifference: false, ambiguous: false })).toBe(true);
    expect(approvalRequired(settings.approvals, { operation: 'suggestion', hasDifference: false, ambiguous: false })).toBe(false);
    expect(approvalRequired(settings.approvals, { operation: 'suggestion', hasDifference: true, ambiguous: false })).toBe(true);
    const off = parseTenantSettings({});
    expect(approvalRequired(off.approvals, { operation: 'manual', hasDifference: true, ambiguous: true })).toBe(false);
  });
});
