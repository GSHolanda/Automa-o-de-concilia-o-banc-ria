# 10. Testes e resultados

Este documento registra como rodar cada suíte, o resultado da última execução completa e a cobertura de cada critério de aceitação (CA-01 a CA-28 de `01-requisitos.md`).

## 1. Como rodar

Pré-requisitos: Node.js 22 ou superior, pnpm 10, PostgreSQL 16 em execução na porta 5432 (no Debian/Ubuntu: `pg_ctlcluster 16 main start`). Os testes de API e de banco usam o usuário `postgres` com senha `postgres` em `localhost:5432`, criando e removendo bancos próprios a cada execução.

```bash
pnpm install
pnpm --filter @concilia/core test            # domínio puro, sem banco
pnpm --filter @concilia/api test             # API, banco, isolamento, segurança, ops
pnpm --filter @concilia/api exec vitest run test/api/imports.test.ts   # um arquivo só
pnpm -r typecheck                            # tipos de todos os pacotes
pnpm --filter @concilia/web build            # build da interface
pnpm --filter @concilia/e2e test             # ponta a ponta (Playwright + Chromium)
```

O e2e sobe API, banco, `demo:seed` e navegador sozinho. Ele regrava as capturas em `docs/capturas/`; após rodar, restaure-as com `git checkout -- docs/capturas/` se não quiser alterá-las.

## 2. Resultados da última execução

Execução completa em 16/11/2026, em sequência, no ambiente local de desenvolvimento (horários em UTC).

| Suíte | Início (UTC) | Fim (UTC) | Arquivos | Resultado |
|---|---|---|---|---|
| `@concilia/core test` | 23:47:55 | 23:47:57 | 11 | 204 testes passando, 0 falhas |
| `@concilia/api test` | 23:47:57 | 23:48:37 | 28 | 303 testes passando, 0 falhas (banco PostgreSQL real) |
| `pnpm -r typecheck` | 23:48:37 | 23:48:40 | pacotes core, api, web, e2e | sem erros de tipo (saída 0) |
| `@concilia/web build` | 23:48:40 | 23:48:41 | — | build concluído (saída 0); `index` com 617,57 kB (181,91 kB gzip) |
| `@concilia/e2e test` | 23:48:41 | 23:49:40 | 10 | 28 testes passando em 58,1 s, 0 falhas |

Total de testes automatizados: 204 + 303 + 28 = 535, sem falhas. A suíte de API cria e remove bancos próprios a cada execução; a de e2e cria um ambiente isolado.

O build da interface emite aviso de chunk acima de 500 kB; não é erro e está registrado em `11-limitacoes-riscos-dependencias.md`.

## 3. Cobertura dos critérios de aceitação

Cada linha indica os arquivos de teste que cobrem o critério. Caminhos são relativos à raiz do repositório. Nenhum critério ficou sem cobertura direta; as ressalvas estão na última coluna.

| CA | Critério (resumo) | Arquivos de teste | Ressalva |
|---|---|---|---|
| CA-01 | OFX Windows-1252 sem tags de fechamento | `packages/core/test/parsers/ofx.test.ts`; `apps/api/test/api/imports.test.ts` | — |
| CA-02 | CSV com `;` e `1.234,56`, colunas débito/crédito | `packages/core/test/parsers/tabular.test.ts`; `apps/api/test/api/imports.test.ts` | — |
| CA-03 | XLSX com datas nativas e valores numéricos | `packages/core/test/parsers/xlsx.test.ts`; `apps/api/test/api/imports.test.ts` | — |
| CA-04 | Reenvio do mesmo arquivo dá duplicidade; período sobreposto importa só o novo | `apps/api/test/api/imports.test.ts` (409 `duplicate_file` e sobreposição) | — |
| CA-05 | Linha com data inválida rejeitada com motivo; demais importadas | `packages/core/test/parsers/tabular.test.ts`; `apps/api/test/api/imports.test.ts` | — |
| CA-06 | Mesmo identificador e valor, par único: conciliação automática com regra | `packages/core/test/matching/engine.test.ts`; `apps/api/test/api/reconciliation.test.ts` | — |
| CA-07 | Dois lançamentos de mesmo valor e data: duas sugestões, nenhuma conciliação | `packages/core/test/matching/engine.test.ts`; `apps/api/test/api/reconciliation.test.ts`; `e2e/tests/03-conciliacao.spec.ts` | — |
| CA-08 | Mesmo identificador com valor diferente: divergência | `packages/core/test/matching/engine.test.ts`; `apps/api/test/api/reconciliation.test.ts` | — |
| CA-09 | Tarifa por regra vira sugestão de classificação | `packages/core/test/matching/engine.test.ts`; `apps/api/test/api/reconciliation.test.ts` (CA-09) | — |
| CA-10 | Débito e crédito de mesmo valor entre contas: transferência interna proposta | `packages/core/test/matching/engine.test.ts`; `apps/api/test/api/reconciliation.test.ts` (CA-10) | — |
| CA-11 | Estorno pareado com a transação original como sugestão | `packages/core/test/matching/engine.test.ts` ("sugere o par transação original e estorno"); `apps/api/test/demo/seed.test.ts` | Cobertura unitária do motor e do seed; sem teste de API específico para o estorno |
| CA-12 | Quem propôs não aprova; outro usuário com permissão aprova | `apps/api/test/api/reconciliation.test.ts` ("quem propôs não aprova (403)"); `apps/api/test/api/access.test.ts`; `e2e/tests/03-conciliacao.spec.ts` | — |
| CA-13 | UPDATE em coluna original de transação rejeitado pelo banco | `apps/api/test/db/audit-immutability.test.ts` (rejeição com "imutáveis"; permissão de estado derivado) | — |
| CA-14 | Desfazer exige justificativa, devolve a pendente e audita | `apps/api/test/api/reconciliation.test.ts` (CA-14); `e2e/tests/04-desfazer.spec.ts` | — |
| CA-15 | Empresa A não lê nem altera recurso da B; retorno 404 | `apps/api/test/db/isolation.test.ts`; `apps/api/test/api/config.test.ts`; `integrations.test.ts`; `ledger-api.test.ts`; `exports.test.ts`; `reconciliation.test.ts`; `imports.test.ts`; `ai.test.ts` | Cobertura por módulo e por rota representativa, não por cada uma das rotas da API |
| CA-16 | Papel da aplicação sem contexto não vê linhas; com contexto A não vê B | `apps/api/test/db/isolation.test.ts` ("sem contexto", "só existem linhas da empresa A") | — |
| CA-17 | UPDATE/DELETE na auditoria rejeitado; adulteração detectada na verificação | `apps/api/test/db/audit-immutability.test.ts` (gatilho para o dono; "aponta o registro adulterado") | — |
| CA-18 | 403 sem permissão; 401 sem autenticação | `apps/api/test/api/auth.test.ts` ("rota protegida sem autenticação responde 401"; "usuário sem a permissão exigida recebe 403") | — |
| CA-19 | Sessão revogada deixa de autenticar de imediato | `apps/api/test/api/auth.test.ts` ("logout revoga a sessão imediatamente"); token de API em `ledger-api.test.ts` | — |
| CA-20 | Exportações CSV, XLSX e PDF geradas, reabertas e com os itens filtrados | `apps/api/test/api/exports.test.ts` (CSV, XLSX, PDF e resumo); `e2e/tests/05-relatorios.spec.ts` | O PDF é reaberto por extrator de texto do próprio teste, não por leitor PDF real |
| CA-21 | Mudar tolerância de data muda a conciliação seguinte | `apps/api/test/api/reconciliation.test.ts` ("alterar a tolerância muda o resultado"); `e2e/tests/07-configuracoes.spec.ts` | — |
| CA-22 | Trabalho que falha é repetido até morrer; reprocessar não duplica | `apps/api/test/api/jobs.test.ts` ("é repetido com espera até o limite e termina morto"); `apps/api/test/api/imports.test.ts` | — |
| CA-23 | Segredo nunca em resposta, log ou auditoria; cifra não decifra em outra empresa | `apps/api/test/api/integrations.test.ts` ("segredo nunca aparece em auditoria"); `apps/api/test/unit/secrets.test.ts`; `apps/api/test/ops/secrets-rotate.test.ts` | — |
| CA-24 | Módulo desabilitado bloqueia as rotas do módulo | `apps/api/test/api/config.test.ts` ("CA-24"); `integrations.test.ts`; `ledger-api.test.ts`; `ai.test.ts`; `notifications.test.ts`; `packages/core/test/access.test.ts` | — |
| CA-25 | Licença suspensa bloqueia escrita e mantém leitura e exportação | `apps/api/test/api/config.test.ts` ("CA-25"); `apps/api/test/api/exports.test.ts` ("licença somente leitura não bloqueia a exportação") | — |
| CA-26 | Fluxo completo no navegador: login, onboarding, importação, conciliação, revisão e exportação | `e2e/tests/01` a `08` (onboarding em `08-plataforma-e-implantacao.spec.ts`) | Executado só em Chromium |
| CA-27 | Integração não alcançada fica com erro e mensagem, nunca "verificada" | `apps/api/test/api/integrations.test.ts` ("CA-27"); `apps/api/test/api/ai.test.ts` ("CA-27"); `apps/api/test/api/notifications.test.ts` ("CA-27: SMTP inalcançável"); `e2e/tests/10-integracoes-e-avisos.spec.ts` | Servidores de teste locais; ver `11-limitacoes-riscos-dependencias.md` |
| CA-28 | Migrações duas vezes não alteram o banco; checksum divergente interrompe | `apps/api/test/db/migrate.test.ts` ("não reaplica migrações"; "interrompe quando uma migração já aplicada foi alterada") | — |

Resumo: 28 de 28 critérios com teste. Nenhum critério ficou "sem cobertura direta". Três têm ressalvas, listadas acima (CA-15, CA-20 e CA-26), e CA-11 tem cobertura apenas unitária e de seed.

## 4. O que os testes não cobrem

Consolidado de `docs/HANDOFF.md` seção 7 e das limitações conhecidas (detalhes em `11-limitacoes-riscos-dependencias.md`):

- **Webhook, conector REST e SMTP** foram testados só contra servidores locais. TLS real e autenticação SMTP real não foram exercitados.
- **Adaptador de IA (Anthropic)** nunca chamou o serviço real, por falta de chave no ambiente. O teste verificado usa servidor local e não conta como verificação do serviço.
- **Docker e Docker Compose** têm arquivos com sintaxe validada, mas não foram executados.
- **`safeFetch` contra destino HTTPS público** não foi testado; as recusas de endereço privado estão testadas.
- **Interface** não tem teste de unidade de componentes; a cobertura é o build, o typecheck e os 28 testes de ponta a ponta.
- **Navegadores:** o e2e roda só em Chromium.
- **Carga e desempenho:** não há testes de carga. A medição de memória da leitura de XLSX está só na revisão de segurança.
- **Backup e restauração:** executados localmente conforme o plano, mas sem teste automatizado no repositório.
- **Vulnerabilidades de dependências, imagem Docker e scripts de backup** estão fora do alcance da revisão de segurança.
- **Comportamento em IPv6** não foi verificado (indisponível no ambiente).
