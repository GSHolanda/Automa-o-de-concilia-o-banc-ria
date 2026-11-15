import type { ModuleKey, PermissionKey } from '@concilia/core/shared';
import type { ReactNode } from 'react';
import { RegrasPage } from './features/configuracoes/RegrasPage';
import { AprovacoesPage } from './features/configuracoes/AprovacoesPage';
import { SegurancaPage } from './features/configuracoes/SegurancaPage';
import { PerfisImportacaoPage } from './features/perfis-importacao/PerfisImportacaoPage';
import { ImplantacaoPage } from './features/implantacao/ImplantacaoPage';
import { AuditoriaPage } from './features/auditoria/AuditoriaPage';
import { PapeisPage } from './features/papeis/PapeisPage';
import { EmpresasPage } from './features/plataforma/EmpresasPage';
import { UsuariosPage } from './features/usuarios/UsuariosPage';
import { CategoriasPage } from './features/cadastros/CategoriasPage';
import { ClassificacaoPage } from './features/cadastros/ClassificacaoPage';
import { ContasBancariasPage } from './features/cadastros/ContasBancariasPage';
import { EstruturaPage } from './features/cadastros/EstruturaPage';
import { ModelosRelatorioPage } from './features/cadastros/ModelosRelatorioPage';
import { PlanoDeContasPage } from './features/cadastros/PlanoDeContasPage';
import { EmpresaPage } from './features/configuracoes/EmpresaPage';
import { IdentidadePage } from './features/configuracoes/IdentidadePage';
import { ModulosPage } from './features/configuracoes/ModulosPage';
import { EmConstrucao } from './pages/EmConstrucao';

export interface AppRoute {
  path: string;
  title: string;
  element: ReactNode;
  permission?: PermissionKey;
  module?: ModuleKey;
  /** Item do menu lateral (um por área). */
  menu?: boolean;
  /** Rota exclusiva do operador da plataforma. */
  platform?: boolean;
  /** Caminho do item de menu quando difere de `path` (grupos). */
  menuPath?: string;
  /** Rotas filhas só ativam o item de menu quando começam por este prefixo. */
  menuMatch?: string;
}

const stub = (title: string) => <EmConstrucao title={title} />;

/** Rotas de negócio. Outras equipes substituem `element` pela tela real da sua área. */
export const APP_ROUTES: AppRoute[] = [
  { path: '/', title: 'Painel', element: stub('Painel'), permission: 'dashboard.view', menu: true },
  { path: '/importacoes', title: 'Importações', element: stub('Importações'), permission: 'imports.view', menu: true },
  { path: '/conciliacao', title: 'Conciliação', element: stub('Conciliação'), permission: 'reconciliation.view', menu: true },
  { path: '/aprovacoes', title: 'Aprovações', element: stub('Aprovações'), permission: 'reconciliation.approve', module: 'approvals', menu: true },
  { path: '/relatorios', title: 'Relatórios', element: stub('Relatórios'), permission: 'exports.create', menu: true },
  { path: '/auditoria', title: 'Auditoria', element: <AuditoriaPage />, permission: 'audit.view', menu: true },
  { path: '/implantacao', title: 'Implantação', element: <ImplantacaoPage />, permission: 'settings.manage', menu: true },
  { path: '/plataforma/empresas', title: 'Empresas', element: <EmpresasPage />, platform: true, menu: true },
];

/** Telas de /configuracoes/... */
type SettingsDef = { path: string; title: string; permission?: PermissionKey; module?: ModuleKey };
const SETTINGS_DEFS: SettingsDef[] = [
  { path: 'empresa', title: 'Empresa' },
  { path: 'identidade-visual', title: 'Identidade visual' },
  { path: 'estrutura', title: 'Estrutura' },
  { path: 'plano-de-contas', title: 'Plano de contas' },
  { path: 'categorias', title: 'Categorias' },
  { path: 'contas-bancarias', title: 'Contas bancárias' },
  { path: 'regras', title: 'Regras e tolerâncias' },
  { path: 'aprovacoes', title: 'Aprovações', module: 'approvals' },
  { path: 'classificacao', title: 'Classificação' },
  { path: 'perfis-importacao', title: 'Perfis de importação' },
  { path: 'seguranca', title: 'Segurança' },
  { path: 'usuarios', title: 'Usuários', permission: 'users.manage' },
  { path: 'papeis', title: 'Papéis', permission: 'users.manage' },
  { path: 'integracoes', title: 'Integrações', permission: 'integrations.manage' },
  { path: 'tokens-api', title: 'Tokens de API', permission: 'integrations.manage' },
  { path: 'notificacoes', title: 'Notificações' },
  { path: 'modelos-relatorio', title: 'Modelos de relatório' },
  { path: 'modulos', title: 'Módulos', permission: 'modules.manage' },
  { path: 'licenca', title: 'Licença' },
];

/** Telas prontas de /configuracoes (chave = `path` de SETTINGS_DEFS). */
const SETTINGS_ELEMENTS: Record<string, ReactNode> = {
  regras: <RegrasPage />,
  aprovacoes: <AprovacoesPage />,
  seguranca: <SegurancaPage />,
  'perfis-importacao': <PerfisImportacaoPage />,
  usuarios: <UsuariosPage />,
  papeis: <PapeisPage />,
  empresa: <EmpresaPage />,
  'identidade-visual': <IdentidadePage />,
  estrutura: <EstruturaPage />,
  'plano-de-contas': <PlanoDeContasPage />,
  categorias: <CategoriasPage />,
  'contas-bancarias': <ContasBancariasPage />,
  classificacao: <ClassificacaoPage />,
  'modelos-relatorio': <ModelosRelatorioPage />,
  modulos: <ModulosPage />,
};

export const SETTINGS_ROUTES: AppRoute[] = SETTINGS_DEFS.map((r) => ({
  permission: 'settings.view' as PermissionKey,
  ...r,
  path: `/configuracoes/${r.path}`,
  element: SETTINGS_ELEMENTS[r.path] ?? stub(r.title),
}));
