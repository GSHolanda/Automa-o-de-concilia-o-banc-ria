# Concilia

Concilia é uma plataforma multiempresa de conciliação bancária: confronta extratos bancários com os lançamentos do sistema financeiro e registra cada decisão com trilha de auditoria. O que muda de uma empresa para outra fica no banco de dados, não no código.

## O que faz e o que não faz

**Faz:**

- Importa extratos (OFX, CSV, XLSX) e lançamentos (CSV, XLSX, ou JSON pela API de entrada).
- Sugere e executa conciliações por conta e período, com aprovação de dois olhos quando a empresa exige.
- Registra decisões, desfazimentos e exportações em uma trilha de auditoria com cadeia de hashes.
- Notifica eventos por aviso interno, e-mail (SMTP) e webhook assinado.

**Não faz:**

- Não conecta em bancos. Não há conexão bancária, open banking nem coleta automática de extratos.
- Não movimenta dinheiro. Não emite pagamentos, transferências nem boletos.
- Não escreve no sistema financeiro. Lê lançamentos por arquivo, pela API de entrada ou por conector REST de leitura, e exporta pendências para que a equipe registre no sistema de origem.

## Estrutura do repositório

| Caminho | Conteúdo |
|---|---|
| `apps/api` | API Fastify com PostgreSQL, migrações (`migrations/`), worker de trabalhos e CLI |
| `apps/web` | Interface React e Vite |
| `packages/core` | Domínio puro, sem banco nem HTTP: dinheiro, datas, parsers, conciliação, contratos v1 |
| `e2e` | Testes de ponta a ponta com Playwright |
| `docs` | Requisitos, arquitetura, modelo de dados, especificações e manuais |
| `ops` | Script de bootstrap do banco, backup, restauração, Dockerfile e alertas |
| `demo` | Documentação dos arquivos de demonstração (fictícios) |
| `config` | Modelos de configuração |

## Desenvolvimento em poucos comandos

Requisitos: Node.js 22 ou superior, pnpm 10 (versão fixada em `package.json`) e PostgreSQL 16.

```bash
# 1. Instalar dependências
pnpm install

# 2. Criar papéis e banco (como superusuário do PostgreSQL)
DB_OWNER_PASSWORD='<senha do dono do esquema>' \
DB_APP_PASSWORD='<senha do papel da aplicação>' \
  bash ops/db-bootstrap.sh

# 3. Variáveis de ambiente
#    Copie os nomes de .env.example e exporte-os no shell.
#    O projeto não carrega o arquivo .env automaticamente.
#    Obrigatórias: DATABASE_URL, SESSION_SECRET (32+ caracteres),
#    SECRETS_MASTER_KEY (32 bytes em base64: openssl rand -base64 32).

# 4. Migrações (usa o papel dono do esquema)
MIGRATION_DATABASE_URL='postgres://concilia_owner:<senha>@localhost:5432/concilia' \
  pnpm db:migrate

# 5. Dados de demonstração (empresa fictícia "demo")
DEMO_PASSWORD='<senha dos quatro usuários de demonstração>' \
  pnpm cli demo:seed

# 6. API (porta 3000) e interface (porta 5173, com proxy para /api)
pnpm dev:api
pnpm dev:web
```

Para processar trabalhos em segundo plano (importações, conciliações, entregas de webhook), rode também o worker em outro terminal:

```bash
pnpm worker
```

Se o PostgreSQL estiver parado no ambiente local, inicie-o antes do passo 2. No Debian ou Ubuntu com cluster 16: `pg_ctlcluster 16 main start`.

Outros comandos da CLI (`pnpm cli <comando>`): `platform:create-admin`, `tenant:create`, `audit:verify`. Use `pnpm cli help` para as opções. Detalhes de instalação estão em `docs/05-instalacao-e-atualizacao.md`.

## Testes

```bash
# Domínio puro (packages/core)
pnpm --filter @concilia/core test

# API (apps/api), com banco local
pnpm --filter @concilia/api test

# Um arquivo só, por exemplo
pnpm --filter @concilia/api exec vitest run test/api/ledger-api.test.ts

# Ponta a ponta (e2e). Cria um ambiente isolado com banco próprio.
pnpm test:e2e

# Tipos de todos os pacotes e build da interface
pnpm typecheck
pnpm --filter @concilia/web build
```

O e2e usa `TEST_ADMIN_DATABASE_URL` (padrão `postgres://postgres:postgres@localhost:5432/postgres`) e um Chromium instalado no sistema. Os dados de teste são todos fictícios.

`pnpm test` na raiz roda o script `test` de cada pacote, em sequência. Isso inclui o e2e, que exige o banco e o Chromium descritos acima. Para rodar só o e2e, use `pnpm test:e2e`.

## Documentação

| Documento | Conteúdo | Situação |
|---|---|---|
| [`docs/01-requisitos.md`](docs/01-requisitos.md) | Requisitos e critérios de aceitação (CA-xx) | Disponível |
| [`docs/02-arquitetura.md`](docs/02-arquitetura.md) | Decisões de arquitetura (ADR) | Disponível |
| [`docs/03-modelo-de-dados.md`](docs/03-modelo-de-dados.md) | Modelo de dados e esquema | Disponível |
| [`docs/04-api-e-conectores.md`](docs/04-api-e-conectores.md) | Referência da API, rotas, webhooks e conectores | Disponível |
| [`docs/05-instalacao-e-atualizacao.md`](docs/05-instalacao-e-atualizacao.md) | Instalação e atualização | Disponível |
| `docs/06-manual-do-administrador.md` | Manual do administrador da empresa | A escrever |
| `docs/07-manual-de-personalizacao.md` | Como personalizar regras, perfis e modelos por empresa | A escrever |
| [`docs/08-operacao-backup-recuperacao.md`](docs/08-operacao-backup-recuperacao.md) | Operação, backup e recuperação | Disponível |
| `docs/09-seguranca-e-lgpd.md` | Segurança e LGPD | A escrever |
| `docs/10-testes-e-resultados.md` | Testes e resultados | A escrever |
| `docs/11-limitacoes.md` | Limitações conhecidas | A escrever |
| [`docs/especificacao-backend.md`](docs/especificacao-backend.md) | Contrato das etapas E5 a E10 | Disponível |
| [`docs/especificacao-frontend.md`](docs/especificacao-frontend.md) | Telas da interface | Disponível |
| [`docs/orquestracao.md`](docs/orquestracao.md) | Política de delegação e registro de execução | Disponível |
| [`docs/plano-de-implementacao.md`](docs/plano-de-implementacao.md) | Plano de implementação | Disponível |

## Regras que valem para todo o código

- Dinheiro em centavos inteiros. Datas civis `AAAA-MM-DD`. Entrada positiva, saída negativa.
- Toda consulta roda com contexto de empresa. Recurso de outra empresa responde 404.
- Registros de origem (`bank_transactions`, `ledger_entries`) nunca são alterados. Decisões ficam em `matches`.
- Toda operação que altera estado grava auditoria na mesma transação.
- Integração externa só fica `verified` após chamada real bem-sucedida.
- Sem dados reais em testes e demonstrações.
