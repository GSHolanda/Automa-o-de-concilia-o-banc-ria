# Plano de implementação

Especificação: `01-requisitos.md` e `02-arquitetura.md`.

Cada etapa termina com um comando de verificação e um commit. O estado real de cada etapa (implementado, testado, dependente de serviço externo) é registrado na seção "Situação" ao final deste documento, à medida que as etapas são concluídas.

## Restrições globais

- Valores em centavos inteiros. Datas civis como `AAAA-MM-DD`.
- Entrada positiva, saída negativa, nos dois lados.
- Nenhum dado real em testes ou demonstração.
- Nenhuma conexão bancária, nenhuma credencial bancária.
- Registros originais não são alterados.
- Integração externa só é "verificada" após chamada real bem-sucedida.
- Textos de interface em português do Brasil.

## Etapas

### E1 — Fundação e primitivas de domínio

Monorepo (pnpm), TypeScript estrito, Vitest. Em `packages/core`: `money` (leitura e formatação de valores), `dates` (leitura de datas, diferença em dias), `text` (normalização, tokens, extração de referências, normalização de identificadores).

Verificação: `pnpm --filter @concilia/core test`.

### E2 — Leitores e preparação de dados

Leitor OFX (1.x e 2.x), CSV, XLSX; mapeamento tabular por perfil; detecção de formato e sugestão heurística de mapeamento; regras de classificação (tarifa, imposto, juros, estorno, transferência); chave de deduplicação com índice de ocorrência.

Verificação: testes unitários com arquivos fictícios (CA-01, CA-02, CA-03).

### E3 — Motor de conciliação

Fases: identificador + valor; valor + data + referência; valor + data com candidato único; tolerância; agrupamento N:1 e 1:N; transferências internas; estornos; tarifas. Pontuação e decomposição.

Verificação: testes unitários (CA-06 a CA-11), incluindo determinismo e ausência de conciliação automática em casos ambíguos.

### E4 — Banco de dados

Migrações: esquema, papéis, RLS, chaves compostas, gatilhos de imutabilidade, auditoria encadeada, fila. Executor de migrações com checksum. Utilitários de contexto de transação.

Verificação: testes de banco (CA-13, CA-16, CA-17, CA-28).

### E5 — API: base, autenticação, autorização, auditoria

Servidor, configuração validada, erros padronizados, utilitário de rota (validação, permissão, OpenAPI), login, sessões, senha, CSRF, limite de requisições, papéis, operador da plataforma, CLI.

Verificação: testes de integração (CA-18, CA-19).

### E6 — Configuração por empresa

Empresa e identidade visual, estrutura organizacional, plano de contas, categorias, contas bancárias, regras, classificação, usuários e papéis, perfis de importação, modelos de relatório, módulos, licença, onboarding.

Verificação: testes de integração (CA-21, CA-24, CA-25) e isolamento (CA-15).

### E7 — Fila e importação

Fila com idempotência e repetição. Envio, pré-visualização, confirmação, processamento, rejeições, conflitos, reprocessamento.

Verificação: testes de integração (CA-04, CA-05, CA-22).

### E8 — Conciliação e revisão

Execução, persistência, listagem com filtros e pesquisa, painel, aceitar, rejeitar, manual, classificar, ignorar, desfazer, aprovação em duas etapas.

Verificação: testes de integração (CA-06 a CA-10, CA-12, CA-14).

### E9 — Exportação

CSV, XLSX, PDF; modelos de relatório; auditoria de exportação.

Verificação: testes de integração (CA-20).

### E10 — Integrações

Cofre de segredos, tokens de API, API de entrada de lançamentos, webhooks assinados, notificações, conector REST de leitura, interface de IA.

Verificação: testes de integração (CA-23, CA-27). Chamadas HTTP de saída são testadas contra servidor local de teste, identificado como tal.

### E11 — Interface

Login, painel, importações, conciliação, aprovações, relatórios, auditoria, configurações, onboarding, área do operador da plataforma.

Verificação: `pnpm --filter @concilia/web build` e verificação de tipos.

### E12 — Ponta a ponta, operação e documentação

Dados fictícios de demonstração, testes Playwright (CA-26), métricas e saúde, Dockerfile e compose, CI, scripts de backup e restauração, documentos 03 a 11.

Verificação: `pnpm test:e2e`; backup e restauração executados localmente.

## Pontos de atenção para revisão

Situações que a especificação implica e que merecem teste dedicado:

1. Arquivo com período sobreposto a um já importado (não pode duplicar).
2. Várias transações idênticas legítimas no mesmo dia (não podem ser descartadas como duplicadas).
3. Mesmo identificador em várias parcelas com valores diferentes.
4. Dois usuários decidindo a mesma sugestão ao mesmo tempo.
5. Arquivo com codificação ou delimitador diferente do perfil.

## Situação

Atualizada ao final de cada etapa. Última atualização: 16/11/2026, com a execução completa das suítes (horários em UTC). Números das suítes: core 204 testes (11 arquivos), API 303 (28 arquivos), e2e 28 testes. Os testes são por suíte; não há contagem separada por etapa, por isso cada linha aponta os arquivos que a cobrem.

| Etapa | Implementado | Testado | Depende de serviço externo |
|---|---|---|---|
| E1 Fundação e primitivas | Sim | `packages/core`: 204 testes passando (dinheiro, datas, texto) | Não |
| E2 Leitores e preparação | Sim (OFX, CSV, XLSX) | `packages/core/test/parsers/*`, dentro dos 204 do core; `apps/api/test/api/imports*.test.ts` | Não |
| E3 Motor de conciliação | Sim (motor 1.2.0) | `packages/core/test/matching/engine.test.ts`, dentro dos 204 do core | Não |
| E4 Banco de dados | Sim (migrações 0001 a 0007) | `apps/api/test/db/*` (isolamento, imutabilidade, migrações), dentro dos 303 da API | Não |
| E5 API: base, autenticação, autorização, auditoria | Sim | `apps/api/test/api/auth.test.ts`, `access.test.ts`, `unit/password.test.ts`, dentro dos 303 da API | Não |
| E6 Configuração por empresa | Sim | `apps/api/test/api/config.test.ts`, dentro dos 303 da API; `packages/core/test/access.test.ts` | Não |
| E7 Fila e importação | Sim | `apps/api/test/api/imports.test.ts`, `jobs.test.ts`, `imports-xlsx-limits.test.ts`, dentro dos 303 da API | Não |
| E8 Conciliação e revisão | Sim | `apps/api/test/api/reconciliation*.test.ts`, dentro dos 303 da API; e2e `03` e `04` | Não |
| E9 Exportação | Sim (CSV, XLSX, PDF) | `apps/api/test/api/exports.test.ts`, dentro dos 303 da API; e2e `05` | Não |
| E10 Integrações | Sim (webhook, SMTP, conector REST, IA, tokens de API, notificações) | `apps/api/test/api/integrations.test.ts`, `notifications.test.ts`, `ledger-api.test.ts`, `ai.test.ts`, dentro dos 303 da API; e2e `10` | Sim: webhook, SMTP, conector REST e IA só testados contra servidores locais; chamada real não verificada |
| E11 Interface | Sim (todas as telas da especificação) | Build e typecheck limpos; e2e: 28 testes passando | Não |
| E12 Ponta a ponta, operação e documentação | Sim (e2e, CLI de operação, documentos 01 a 11) | e2e: 28 testes passando; `apps/api/test/ops/*` dentro dos 303 da API | Sim: Docker e Compose não executados (sintaxe validada); backup e restauração executados só localmente |
