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
| 3 (E8) | conciliação e revisão | claude-opus-5-5 | high | Execução do motor, decisões, aprovação em duas etapas, painel | 29 testes novos; API total 144 passando | não |
| 4 (telas) | importação | claude-sonnet-5-5 | medium | Lista, nova importação em passos, detalhe | build do web passa | não |
| 7 (demo) | arquivos fictícios | claude-haiku-5-5 | low | Gerador determinístico de OFX, CSV e XLSX | 8 testes passando | não |
| 3 (motor) | ajuste após achado da E8 | orquestrador | xhigh | Candidato restante após rejeição humana vira sugestão | core 173 passando | — |
Modelo "solicitado": o ambiente aceitou o parâmetro na delegação. Confirmação do ambiente obtida em 16/11: as chamadas
de opus, sonnet e haiku foram enviadas à API como `claude-opus-5-5`, `claude-sonnet-5-5` e `claude-haiku-5-5`.
Os agentes de `.claude/agents/` passaram a ser reconhecidos após o reinício do processo da sessão.
Consumo informado pelo ambiente por subagente: operação 88 mil tokens; base web 120 mil; E5 208 mil; E6 151 mil; E7 266 mil; telas 120 + 129 + 145 + 133 mil; E8 295 mil; demo 133 mil.

Custo real da sessão do orquestrador até este ponto, informado pelo ambiente: US$ 16,60.

## Próximos passos (fila de trabalho)
Qualquer sessão pode continuar daqui lendo `CLAUDE.md`, este arquivo e as duas especificações.

1. Concluídos: E8, telas de importação, arquivos fictícios de demonstração.
2. Em andamento: E9 exportação (`dev-intermediario`); E10 integrações (`dev-complexo`, em cópia isolada);
   telas de conciliação, painel e aprovações (`dev-intermediario`).
3. Em seguida: telas de relatórios, integrações, tokens de API e notificações (`dev-intermediario`);
   comando `demo:seed` que cria a empresa de demonstração, importa os arquivos e executa a conciliação (`dev-intermediario`).
4. Testes ponta a ponta com Playwright (CA-26) e correção de incompatibilidades entre telas e API (`dev-intermediario`).
5. Backup e restauração executados localmente; documentos 03 a 11 e manuais (`dev-simples`); seção "Situação" do plano.
6. Revisão final de isolamento e segurança, uma única vez (`revisor-critico`).

Interrupções: em 15–16/11 o limite de uso da conta interrompeu três agentes; foram retomados do ponto em que pararam.
