# Orquestração e registro de execução

## Política de delegação
O orquestrador planeja, escreve as especificações, delega e verifica (roda os testes e registra o commit).
Cada tarefa vai para o modelo mais econômico capaz de entregá-la com verificação.

| Agente | Modelo | Esforço | Usado para |
|---|---|---|---|
| `dev-simples` | haiku | low | Configuração, documentação básica, dados fictícios, ajustes mecânicos |
| `dev-intermediario` | sonnet | medium | Interface, CRUD, painéis, relatórios, testes convencionais |
| `dev-complexo` | opus | high | Banco, isolamento, importação, motor, APIs, autenticação, integrações, testes de segurança |
| `revisor-critico` | fable | high | Só em escalonamento: revisão de alto impacto ou falha persistente |

Definições em `.claude/agents/`. Contexto comum em `CLAUDE.md`; cada tarefa recebe apenas a seção da especificação
que lhe cabe. Escalonamento exige resumo com: problema, arquivos, tentativas, testes, erros restantes, objetivo.

## Distribuição por etapa
| Etapa | Conteúdo | Agente |
|---|---|---|
| 1 Planejamento | Requisitos, arquitetura, especificações | orquestrador |
| 2 Estrutura inicial | Monorepo, domínio, ambiente de testes | orquestrador (antes da política) |
| 3 Backend | E5 acesso · E7 importação · E8 conciliação · E10 integrações | dev-complexo |
| 3 Backend | E6 configuração (CRUD) · E9 exportação | dev-intermediario |
| 4 Frontend | Base e telas | dev-intermediario |
| 5 Integração | Conectores e ligação entre módulos | dev-complexo |
| 6 Testes | Isolamento e segurança: dev-complexo · ponta a ponta: dev-intermediario | — |
| 7 Preparação comercial | Arquivos de operação, dados de demonstração, manuais | dev-simples |

## Registro de execução
Modelo e esforço são os informados pelo ambiente. Custo só aparece quando há métrica real.

| Etapa | Agente | Modelo | Esforço | Resultado | Testes | Escalonou |
|---|---|---|---|---|---|---|
| 1–2 e início da 3 (E1–E4, parte da E5) | orquestrador | claude-fable-5-2 | xhigh | Domínio, migrações, base da API | core 171, banco 31, todos passando | — |
| 7 (operação) | arquivos de operação | haiku (solicitado) | low | `.env.example`, Docker, compose, CI, backup, alertas | sintaxe de shell e YAML conferida; Docker não executado neste ambiente | não |
| 4 (base) | base da interface | sonnet (solicitado) | medium | Componentes, autenticação, navegação por permissão | build do web passa | não |
| 3 (E5) | acesso e sessões | opus (solicitado) | high | Login, sessões, usuários, papéis, auditoria, plataforma, CLI | API 53 testes passando; typecheck limpo | não |

| 3 (E6) | configuração por empresa | sonnet (solicitado) | medium | Configurações, cadastros, módulos, licença, onboarding | 30 testes novos; integrado | não |
| 3 (E7) | fila e importação | opus (solicitado) | high | Fila com repetição e idempotência; importação OFX/CSV/XLSX | 24 testes novos; API total 107 passando | não |
| 4 (telas) | acesso, auditoria, plataforma, configurações, implantação | sonnet (solicitado) | medium | 3 tarefas de telas | build do web passa; sem teste contra a API ainda | não |
Modelo "solicitado": o ambiente aceitou o parâmetro na delegação, mas não informa o modelo que atendeu.
Consumo informado pelo ambiente por subagente: operação 88 mil tokens; base web 120 mil; E5 208 mil; E6 151 mil; E7 266 mil; telas 120 + 129 + 145 mil.

Custo real da sessão do orquestrador até este ponto, informado pelo ambiente: US$ 16,60.
