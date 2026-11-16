import type { ModuleKey, PermissionKey } from '@concilia/core/shared';
import type { ReactNode } from 'react';
import { RegrasPage } from './features/configuracoes/RegrasPage';
import { AprovacoesPage as AprovacoesConfigPage } from './features/configuracoes/AprovacoesPage';
import { AprovacoesPage } from './features/aprovacoes/AprovacoesPage';
import { PainelPage } from './features/painel/PainelPage';
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
import { ImportacaoDetalhePage } from './features/importacoes/ImportacaoDetalhePage';
import { ImportacoesPage } from './features/importacoes/ImportacoesPage';
import { NovaImportacaoPage } from './features/importacoes/NovaImportacaoPage';
import { ConciliacaoPage } from './features/conciliacao/ConciliacaoPage';
import { RelatoriosPage } from './features/relatorios/RelatoriosPage';
import { IntegracoesPage } from './features/integracoes/IntegracoesPage';
import { NotificacoesPage } from './features/integracoes/NotificacoesPage';
import { TokensApiPage } from './features/integracoes/TokensApiPage';
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
  { path: '/', title: 'Painel', element: <PainelPage />, permission: 'dashboard.view', menu: true },
  { path: '/importacoes', title: 'Importações', element: <ImportacoesPage />, permission: 'imports.view', menu: true },
  { path: '/importacoes/nova', title: 'Nova importação', element: <NovaImportacaoPage />, permission: 'imports.create' },
  { path: '/importacoes/:id', title: 'Importação', element: <ImportacaoDetalhePage />, permission: 'imports.view' },
  { path: '/conciliacao', title: 'Conciliação', element: <ConciliacaoPage />, permission: 'reconciliation.view', menu: true },
  { path: '/aprovacoes', title: 'Aprovações', element: <AprovacoesPage />, permission: 'reconciliation.approve', module: 'approvals', menu: true },
  { path: '/relatorios', title: 'Relatórios', element: <RelatoriosPage />, permission: 'exports.create', menu: true },
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
  { path: 'notificacoes', title: 'Notificações', permission: 'settings.manage' },
  { path: 'modelos-relatorio', title: 'Modelos de relatório' },
  { path: 'modulos', title: 'Módulos', permission: 'modules.manage' },
  { path: 'licenca', title: 'Licença' },
];

/** Telas prontas de /configuracoes (chave = `path` de SETTINGS_DEFS). */
const SETTINGS_ELEMENTS: Record<string, ReactNode> = {
  regras: <RegrasPage />,
  aprovacoes: <AprovacoesConfigPage />,
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
  licenca: <ModulosPage title="Licença" />,
  integracoes: <IntegracoesPage />,
  'tokens-api': <TokensApiPage />,
  notificacoes: <NotificacoesPage />,
};

export const SETTINGS_ROUTES: AppRoute[] = SETTINGS_DEFS.map((r) => ({
  permission: 'settings.view' as PermissionKey,
  ...r,
  path: `/configuracoes/${r.path}`,
  element: SETTINGS_ELEMENTS[r.path] ?? stub(r.title),
}));
