/** Registro de módulos do produto. Obrigatórios estão sempre ativos; opcionais dependem do plano e da empresa. */
export interface ModuleDefinition {
  key: string;
  name: string;
  description: string;
  required: boolean;
  /** Depende de serviço externo configurado pela empresa. */
  externalDependency?: string;
}

export const MODULES = [
  {
    key: 'core.reconciliation',
    name: 'Conciliação',
    description: 'Importação, normalização, motor de conciliação, revisão, painel e exportação.',
    required: true,
  },
  {
    key: 'core.access',
    name: 'Acesso',
    description: 'Autenticação, usuários, papéis e sessões.',
    required: true,
  },
  {
    key: 'core.audit',
    name: 'Auditoria',
    description: 'Trilha de auditoria encadeada e verificação de integridade.',
    required: true,
  },
  {
    key: 'approvals',
    name: 'Aprovação em duas etapas',
    description: 'Decisões definidas nas regras exigem aprovação de uma segunda pessoa.',
    required: false,
  },
  {
    key: 'grouping',
    name: 'Agrupamento',
    description: 'Sugere uma transação como soma de vários lançamentos, e o inverso.',
    required: false,
  },
  {
    key: 'transfers',
    name: 'Transferências internas',
    description: 'Pareia débito e crédito entre contas bancárias da própria empresa.',
    required: false,
  },
  {
    key: 'api.inbound',
    name: 'API de lançamentos',
    description: 'Recebe lançamentos do sistema financeiro por API autenticada com token.',
    required: false,
  },
  {
    key: 'connector.rest',
    name: 'Conector REST',
    description: 'Busca lançamentos em uma API REST do sistema financeiro.',
    required: false,
    externalDependency: 'API do sistema financeiro da empresa',
  },
  {
    key: 'notifications.webhook',
    name: 'Notificações por webhook',
    description: 'Envia eventos assinados para um endereço HTTPS da empresa.',
    required: false,
    externalDependency: 'Endereço HTTPS da empresa',
  },
  {
    key: 'notifications.email',
    name: 'Notificações por e-mail',
    description: 'Envia avisos por e-mail usando o servidor SMTP da empresa.',
    required: false,
    externalDependency: 'Servidor SMTP',
  },
  {
    key: 'ai.assist',
    name: 'Sugestões por IA',
    description: 'Sugere categoria para transações sem correspondência. Sempre sujeito a aceite humano.',
    required: false,
    externalDependency: 'Provedor de IA e chave de API da empresa',
  },
] as const satisfies readonly ModuleDefinition[];

export type ModuleKey = (typeof MODULES)[number]['key'];

export const MODULE_KEYS = MODULES.map((module) => module.key) as ModuleKey[];
export const OPTIONAL_MODULE_KEYS = MODULES.filter((module) => !module.required).map(
  (module) => module.key,
) as ModuleKey[];

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as string[]).includes(value);
}

/** Módulos efetivamente ativos: obrigatórios, mais opcionais que estão no plano e habilitados pela empresa. */
export function resolveEnabledModules(
  planModules: readonly string[],
  tenantModules: ReadonlyArray<{ key: string; enabled: boolean }>,
): ModuleKey[] {
  const inPlan = new Set(planModules);
  const enabled = new Set(tenantModules.filter((entry) => entry.enabled).map((entry) => entry.key));
  return MODULES.filter((module) => module.required || (inPlan.has(module.key) && enabled.has(module.key))).map(
    (module) => module.key,
  );
}

export function canEnableModule(key: string, planModules: readonly string[]): boolean {
  const module = MODULES.find((entry) => entry.key === key);
  return module !== undefined && !module.required && planModules.includes(key);
}
