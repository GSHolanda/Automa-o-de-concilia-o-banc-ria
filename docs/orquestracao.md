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
| 3 (E9) | exportação | claude-sonnet-5-5 | medium | CSV, XLSX e PDF; modelos de relatório | 15 testes novos | não |
| 3/5 (E10) | integrações | claude-opus-5-5 | high | Cofre, tokens, API de entrada, webhooks, SMTP, conector REST, IA | 65 testes novos; API total 239 passando | não |
| 4 (telas) | conciliação, painel, aprovações, relatórios | claude-sonnet-5-5 | medium | 3 tarefas de telas | build do web passa | não |
| 7 (demo) | comando demo:seed | claude-sonnet-5-5 | medium | Empresa de demonstração pelos serviços da aplicação | 11 testes dos cenários | não |
| 6 (e2e) | testes ponta a ponta | claude-sonnet-5-5 | medium | 21 testes no navegador; rota de contagens | 21 passando | não |
| 7 (docs) | documentos 03, 05, 08 | claude-haiku-5-5 | low | Modelo de dados, instalação, operação | backup e restauração executados | não |
| 3/5 (op/LGPD) | retenção, troca de chave, exportação e eliminação | claude-opus-5-5 | high | 4 operações com testes | API 258 | não |
| 4 (telas) | integrações, tokens, notificações, avisos, IA | claude-sonnet-5-5 | medium | telas + 7 testes e2e | e2e 28 | não |
| 6 (e2e) | corrida no logout | claude-sonnet-5-5 + orquestrador | medium | consultas canceladas no logout; e2e sai pela interface | e2e 28/28 ×3 | não |
| 7 (docs) | 04, README, 06, 07, 09 | haiku / sonnet | low / medium | documentação | — | não |
| 6 (revisão) | revisão de segurança | claude-fable-5-2 (revisor-critico) | high | 14 achados: 0 críticos, 3 altos, 5 médios, 6 baixos | 11 confirmados por execução | — |
| 6 (correções) | achados 1–2 e 3–14 | claude-opus-5-5 | high | todos os 14 corrigidos (11 com mitigação parcial registrada) | core 204, API 303, e2e 28 | não |
Modelo "solicitado": o ambiente aceitou o parâmetro na delegação. Confirmação do ambiente obtida em 16/11: as chamadas
de opus, sonnet e haiku foram enviadas à API como `claude-opus-5-5`, `claude-sonnet-5-5` e `claude-haiku-5-5`.
Os agentes de `.claude/agents/` passaram a ser reconhecidos após o reinício do processo da sessão.
Consumo informado pelo ambiente por subagente: operação 88 mil tokens; base web 120 mil; E5 208 mil; E6 151 mil; E7 266 mil; telas 120 + 129 + 145 + 133 mil; E8 295 mil; demo 133 mil; E9 153 mil; E10 373 mil; telas 110 + 144 + 88 mil; seed 154 mil; e2e 286 mil; docs 192 mil; op/LGPD 217 mil; telas 187 mil; API/README 151 mil; manuais 314 mil; LGPD 165 mil; revisão 445 mil; correções 194 + 399 mil.

Custo real da sessão informado pelo ambiente em 16/11 18:38 UTC: US$ 116,38. A partir do handoff, os commits são
feitos exclusivamente em nome do titular (ver `CLAUDE.md`, seção Versionamento).

Custo real da sessão do orquestrador até este ponto, informado pelo ambiente: US$ 16,60.

## Próximos passos (fila de trabalho)
Qualquer sessão pode continuar daqui lendo `CLAUDE.md`, este arquivo e as duas especificações.

1. Concluídos e integrados: E5 a E10, telas principais, demonstração, testes ponta a ponta, documentos 03, 05 e 08.
2. Em andamento: telas de integrações, tokens de API e notificações (`dev-intermediario`); operação e LGPD — expurgo
   de arquivos por retenção, troca da chave mestra, exportação e eliminação de dados de uma empresa (`dev-complexo`);
   documento 04 e README (`dev-simples`).
3. Depois: manuais 06 e 07 e documento 09 (`dev-intermediario`); documento 10 com os números finais (`dev-simples`);
   documento 11 e seção "Situação" do plano (orquestrador).
4. Revisão final de isolamento e segurança, uma única vez (`revisor-critico`), e correções que ela apontar.

Interrupções: em 15–16/11 o limite de uso da conta interrompeu agentes em três ocasiões; todos foram retomados do
ponto em que pararam, sem refazer trabalho.
