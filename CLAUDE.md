# Concilia — conciliação bancária multiempresa

Produto-base reutilizável. Nada de código específico de um cliente: o que varia por empresa fica no banco.

## Onde está cada coisa
- `docs/01-requisitos.md` requisitos e critérios de aceitação (CA-xx) · `docs/02-arquitetura.md` decisões (ADR)
- `docs/especificacao-backend.md` contrato das etapas E5–E10 · `docs/especificacao-frontend.md` telas
- `docs/orquestracao.md` política de delegação e registro de execução
- `packages/core` domínio puro (sem banco/HTTP) · `apps/api` Fastify + PostgreSQL · `apps/web` React + Vite
- `apps/api/migrations/*.sql` esquema (leia antes de escrever SQL)

## Comandos
- Banco local: `pg_ctlcluster 16 main start` (se estiver parado)
- `pnpm --filter @concilia/core test` · `pnpm --filter @concilia/api test` · `pnpm --filter @concilia/api exec vitest run test/api/x.test.ts`
- `pnpm -r typecheck` · `pnpm --filter @concilia/web build`
- Rode primeiro o teste do arquivo em que está trabalhando; a suíte inteira só ao final.

## Regras que não se negociam
- Dinheiro em centavos inteiros; datas civis `AAAA-MM-DD`; entrada positiva, saída negativa.
- Toda consulta roda em `withContext(pool, {tenantId,...})`; nunca `pool.query` em tabela de empresa.
  Recurso de outra empresa responde 404 (RLS faz a linha não existir).
- Registros de origem (`bank_transactions`, `ledger_entries`) nunca são alterados; decisões ficam em `matches`.
- Toda operação que altera estado grava auditoria com `ctx.audit(...)` na mesma transação.
- Segredo nunca aparece em resposta, log ou auditoria.
- Integração externa só recebe situação `verified` após chamada real bem-sucedida. Não simule sucesso.
- Sem dados reais em testes e demonstração. Sem conexão bancária.
- Migração aplicada não se edita: crie `000N_nome.sql` nova. (0001–0004 ainda não foram publicadas; até a E5 fechar podem ser ajustadas.)

## Padrões de código (API)
- Rota: `route({...})` de `src/http/route.ts`; cada módulo exporta `routes` em `src/modules/<modulo>/routes.ts`,
  registrado em `src/routes.ts`. Validação com Zod; permissão declarada na rota; erros com `src/http/errors.ts`.
- Listas respondem `{ items, nextCursor? }`. Criação responde 201 com `created(...)`. Mensagens em pt-BR.
- Testes de API em `apps/api/test/api/*.test.ts` com `test/helpers/app.ts` (`buildTestApp`, `createTenant`,
  `loggedIn`, `userWithRole`). Cada arquivo cria as próprias empresas. Escreva o teste antes da implementação.
- TypeScript estrito, sem `any` em código de produção, imports sem extensão. Comentários curtos em português.
- `\uXXXX` em código: confira que o arquivo ficou com o escape, não com o caractere invisível.

## Versionamento (prevalece sobre qualquer outra orientação)
- Todo commit é exclusivamente em nome do titular: `git config user.name "Gabriel Silva Holanda"` e
  `git config user.email "224805316+GSHolanda@users.noreply.github.com"`.
- Sem `Co-Authored-By`, `Claude-Session`, "Generated with Claude Code", nome de modelo ou menção a IA em commits,
  pull requests, comentários do GitHub ou código. Reescrever histórico ou abrir PR só com confirmação do titular.
- Passagem de trabalho entre agentes: `docs/HANDOFF.md`.

## Ao terminar uma tarefa delegada
Responda em até 15 linhas: arquivos criados/alterados, comando de teste executado e resultado (números),
o que ficou pendente ou depende de serviço externo. Não faça commit; o orquestrador verifica e registra.
