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

Atualizada ao final de cada etapa.
