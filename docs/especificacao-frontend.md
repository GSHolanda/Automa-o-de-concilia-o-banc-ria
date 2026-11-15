# Especificação da interface (E11)

React 19 + Vite + React Router + TanStack Query. CSS próprio com variáveis (sem biblioteca de componentes).
Textos em português do Brasil. Responsiva a partir de 360 px. A interface fala apenas com `/api/v1`
(contrato em `especificacao-backend.md`; em execução, `GET /api/v1/openapi.json`).

## Base
```
apps/web/
  index.html · vite.config.ts (proxy de /api, /healthz para http://localhost:3000) · tsconfig.json
  src/main.tsx · src/App.tsx (rotas)
  src/api/client.ts     fetch com credentials 'same-origin', JSON, cabeçalho X-CSRF-Token (guardado em memória a
                        partir de /auth/me), classe ApiError {status, code, message, details}, envio multipart,
                        download de arquivo; 401 leva ao login
  src/auth/             AuthProvider (consulta /auth/me), can(permissão), hasModule(chave), RequireAuth,
                        RequirePermission; senha temporária obriga a tela de troca
  src/theme/            tokens.css, base.css, applyBranding(cor) define --cor-primaria e derivadas
  src/components/       Button, Field, Select, Checkbox, Modal, Drawer, Toast, DataTable, Tabs, Badge, StatusBadge,
                        Money, DateText, PageHeader, EmptyState, ConfirmDialog, FileDrop, Spinner, Pagination
  src/layout/AppShell   menu lateral (vira gaveta no celular), barra superior com empresa, avisos e menu do usuário
  src/features/<área>/  uma pasta por área abaixo
```
Tipos, catálogo de permissões, módulos e formatação vêm de `@concilia/core/shared` (nunca de `@concilia/core`).

## Visual
Sóbrio, de sistema financeiro: fundo claro, cinzas neutros, cor principal da empresa (padrão `#0b5cab`).
Situações: conciliado verde, pendente âmbar, divergente vermelho, ignorado cinza, aguardando aprovação azul.
Valores com algarismos tabulares, alinhados à direita, negativos em vermelho. Escala de espaçamento de 4 px.
Fonte do sistema. Foco visível, rótulos em todos os campos, alvos de toque de 40 px. Sem modo escuro nesta versão.
Estados vazios, de carregamento e de erro em toda lista. Ações destrutivas pedem confirmação.

## Telas (rota → API)
| Rota | Conteúdo | API |
|---|---|---|
| `/entrar`, `/trocar-senha` | Login; troca de senha | `/auth/login`, `/auth/password` |
| `/` | Painel: totais por situação (extrato e lançamentos), sugestões abertas, aprovações pendentes, por conta, última importação e execução; filtros de conta e período | `/dashboard`, `/bank-accounts` |
| `/importacoes` | Lista de lotes; nova importação em passos: arquivo → pré-visualização e mapeamento → confirmação → acompanhamento; rejeições; reprocessar | `/imports*`, `/import-profiles`, `/jobs` |
| `/conciliacao` | Abas Sugestões, Pendentes, Divergentes, Conciliados, Ignorados; filtros e pesquisa; gaveta de detalhe com os dois lados e a decomposição da confiança; aceitar, rejeitar, conciliar manualmente, classificar, ignorar, desfazer; aceitar em lote; executar conciliação | `/reconciliation/*` |
| `/aprovacoes` | Fila de aprovação; aprovar, recusar | `/reconciliation/matches?status=pending_approval` |
| `/relatorios` | Exportar itens, resumo e lançamentos a criar em CSV, XLSX, PDF | `/exports/*`, `/report-templates` |
| `/auditoria` | Trilha com filtros; verificação de integridade | `/audit`, `/audit/verify` |
| `/configuracoes/...` | empresa, identidade visual, estrutura, plano de contas, categorias, contas bancárias, regras e tolerâncias, aprovações, classificação, perfis de importação, usuários, papéis, integrações, tokens de API, notificações, modelos de relatório, módulos e licença | `/company`, `/settings`, CRUDs, `/users`, `/roles`, `/integrations`, `/api-tokens`, `/notification-rules`, `/modules`, `/license` |
| `/implantacao` | Assistente de onboarding em etapas | `/onboarding*` |
| `/minha-conta` | Sessões ativas, troca de senha | `/auth/sessions`, `/auth/password` |
| `/plataforma/empresas` | Operador: empresas, plano e licença | `/platform/*` |

Itens de menu e botões respeitam permissão e módulo; licença em somente leitura mostra faixa de aviso e desabilita escrita.

## Componentes disponíveis (base já implementada)
Rotas: tabela `APP_ROUTES` e `SETTINGS_ROUTES` em `apps/web/src/routes.tsx` (`permission`, `module`, `element`).
Uma tela nova entra trocando o `element` da rota (hoje `stub(...)`), uma linha por rota. Telas em `src/features/<área>/`.

- `api` (`src/api/client.ts`): `get/post/put/patch/delete/upload(path, FormData)/download(path, query, nome)`;
  `ApiError {status, code, message, details, requestId}`; `errorMessage(erro)`.
- `useAuth()`: `me, status, can(permissão), hasModule(chave), readOnly, login, logout, refresh`.
  `RequirePermission` (`permission`, `anyOf`, `module`, `platform`).
- `DataTable<T>`: `columns[{key, header, render?, align?, width?, sortable?, hideOnMobile?}]`, `rows`, `rowKey`,
  `caption` (obrigatório), `loading`, `error`, `onRetry`, `emptyTitle`, `emptyDescription`, `emptyAction`,
  `onRowClick`, `selectedKeys` + `onSelectionChange`, `sort` + `onSortChange`, `footer`.
- `Field`: `label` (obrigatório), `hint`, `error`, `multiline` e atributos de input. `FieldShell` para controles
  próprios. `Select`: `label, options[{value,label,disabled}], placeholder, hint, error`. `Checkbox`: `label, hint`.
- `Modal`: `open, title, onClose, footer?, size?: sm|md|lg, dismissible?`. `Drawer`: `open, title, onClose, footer?,
  side?, width?: md|lg|xl`. `ConfirmDialog`: `open, title, message, confirmLabel, destructive, onConfirm, onCancel`.
- `useToast()`: `success(msg)`, `error(msg)`, `info(msg)`.
- `Button`: `variant: primary|secondary|danger|ghost`, `size`, `loading`. `Tabs`: `tabs[{key,label,count?}], value,
  onChange, label`. `Pagination` (cursor): `hasPrev, hasNext, onPrev, onNext, summary, loading`.
- `StatusBadge`: `status`, `label?`. `Money`: `cents`. `DateText`: `value, withTime?`. `FileDrop`: `onFiles, accept,
  multiple, maxSizeMb, onReject`. `PageHeader`, `EmptyState`, `Spinner`, `Badge`.
