/** Catálogo de permissões. Papéis são conjuntos destas chaves, definidos por empresa. */
export const PERMISSIONS = {
  'dashboard.view': 'Ver o painel',
  'imports.view': 'Ver importações',
  'imports.create': 'Importar arquivos',
  'reconciliation.view': 'Ver itens e conciliações',
  'reconciliation.run': 'Executar a conciliação',
  'reconciliation.review': 'Revisar sugestões e propor conciliações',
  'reconciliation.approve': 'Aprovar conciliações pendentes de aprovação',
  'reconciliation.undo': 'Desfazer conciliações',
  'exports.create': 'Exportar relatórios',
  'audit.view': 'Ver a trilha de auditoria',
  'settings.view': 'Ver configurações',
  'settings.manage': 'Alterar configurações e cadastros',
  'users.manage': 'Gerenciar usuários e papéis',
  'integrations.manage': 'Gerenciar integrações e credenciais',
  'modules.manage': 'Habilitar e desabilitar módulos',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export const PERMISSION_GROUPS: ReadonlyArray<{ label: string; keys: PermissionKey[] }> = [
  { label: 'Painel', keys: ['dashboard.view'] },
  { label: 'Importação', keys: ['imports.view', 'imports.create'] },
  {
    label: 'Conciliação',
    keys: [
      'reconciliation.view',
      'reconciliation.run',
      'reconciliation.review',
      'reconciliation.approve',
      'reconciliation.undo',
    ],
  },
  { label: 'Relatórios e auditoria', keys: ['exports.create', 'audit.view'] },
  {
    label: 'Administração',
    keys: ['settings.view', 'settings.manage', 'users.manage', 'integrations.manage', 'modules.manage'],
  },
];

export interface SystemRole {
  key: string;
  name: string;
  description: string;
  permissions: PermissionKey[];
}

/** Papéis criados para toda empresa nova. A empresa pode criar outros a partir do catálogo. */
export const SYSTEM_ROLES: readonly SystemRole[] = [
  {
    key: 'admin',
    name: 'Administrador',
    description: 'Acesso completo à empresa, incluindo configurações, usuários e integrações.',
    permissions: [...PERMISSION_KEYS],
  },
  {
    key: 'gestor',
    name: 'Gestor',
    description: 'Aprova e desfaz conciliações, além de tudo o que o analista faz.',
    permissions: [
      'dashboard.view',
      'imports.view',
      'imports.create',
      'reconciliation.view',
      'reconciliation.run',
      'reconciliation.review',
      'reconciliation.approve',
      'reconciliation.undo',
      'exports.create',
      'audit.view',
      'settings.view',
    ],
  },
  {
    key: 'analista',
    name: 'Analista',
    description: 'Importa arquivos, executa a conciliação e revisa sugestões.',
    permissions: [
      'dashboard.view',
      'imports.view',
      'imports.create',
      'reconciliation.view',
      'reconciliation.run',
      'reconciliation.review',
      'exports.create',
    ],
  },
  {
    key: 'auditor',
    name: 'Auditor',
    description: 'Somente leitura: painel, itens, relatórios e trilha de auditoria.',
    permissions: [
      'dashboard.view',
      'imports.view',
      'reconciliation.view',
      'exports.create',
      'audit.view',
      'settings.view',
    ],
  },
];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export function hasPermission(granted: readonly string[], required: PermissionKey): boolean {
  return granted.includes(required);
}

/** Mantém apenas chaves do catálogo, sem repetição, na ordem do catálogo. */
export function sanitizePermissions(input: readonly string[]): PermissionKey[] {
  const wanted = new Set(input);
  return PERMISSION_KEYS.filter((key) => wanted.has(key));
}
