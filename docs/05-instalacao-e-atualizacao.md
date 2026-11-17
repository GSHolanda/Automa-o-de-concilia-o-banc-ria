# 05. Instalação e atualização

Este guia cobre a instalação do Concilia em um servidor próprio e a atualização de versão. Os caminhos citados são relativos à raiz do projeto.

## Pré-requisitos

- **Node.js 22 ou superior** (`engines` do `package.json`).
- **pnpm 10.28.0** (`packageManager` do `package.json`). Com Node 22, `corepack enable` providencia o pnpm.
- **PostgreSQL 16**. É a versão usada no `ops/docker-compose.yml`.
- **Clientes do PostgreSQL no servidor**: `psql` (bootstrap), `pg_dump` e `pg_restore` (backup e restauração).
- **sha256sum** ou `shasum` (usado pelo `ops/backup.sh`).
- **openssl**, para gerar os segredos. Opcional, qualquer gerador de 32 bytes serve.
- **Docker e Docker Compose v2**, apenas se a instalação for por contêineres.

O código não lê o arquivo `.env`. As variáveis precisam estar no ambiente do processo. Para isso, use `node --env-file=.env` (recurso do Node 22) ou exporte as variáveis no gerenciador de serviço.

## Instalação sem Docker

### 1. Dependências e build

```bash
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` compila o front-end (`apps/web`, com `tsc --noEmit` e `vite build`) e a API (`apps/api`, com `tsup`). A API gera `apps/api/dist/main.js`, `apps/api/dist/worker-main.js` e `apps/api/dist/cli.js`. O front-end fica em `apps/web/dist`.

### 2. Papéis e banco de dados

Execute uma vez por instalação, como superusuário do PostgreSQL:

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD='senha-do-superusuario' \
DB_OWNER_PASSWORD='senha-do-papel-dono' \
DB_APP_PASSWORD='senha-do-papel-da-aplicacao' \
./ops/db-bootstrap.sh
```

O script cria:

- `concilia_owner` (padrão de `DB_OWNER_ROLE`): dono do esquema. Usado só para migrações e backup.
- `concilia_app` (padrão de `DB_APP_ROLE`): papel da aplicação. Não é dono de nada, não tem `BYPASSRLS` e fica sujeito a RLS.
- O banco `concilia` (padrão de `DB_NAME`), com dono `concilia_owner`. O acesso público é revogado e só `concilia_app` recebe `CONNECT`.

Os nomes e a senha de cada papel são definidos pelas variáveis do script. O script não é idempotente nas senhas: rodá-lo de novo com outra senha altera a senha do papel.

### 3. Variáveis de ambiente

Copie o modelo e preencha os valores de produção:

```bash
cp .env.example .env
```

Ajustes obrigatórios em produção:

| Variável | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `COOKIE_SECURE` | `true` (exigido pela configuração em produção) |
| `DATABASE_URL` | `postgres://concilia_app:<senha>@<host>:5432/concilia` |
| `MIGRATION_DATABASE_URL` | `postgres://concilia_owner:<senha>@<host>:5432/concilia` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `SECRETS_MASTER_KEY` | `openssl rand -base64 32` |
| `PASSWORD_SCRYPT_COST` | 15 ou mais (`17` é o recomendado) |
| `ALLOW_PRIVATE_INTEGRATION_HOSTS` | `false` (recusado em produção se estiver `true`) |

A lista completa está na seção "Variáveis de ambiente" deste documento.

Carregue as variáveis no shell para os próximos passos:

```bash
set -a; . ./.env; set +a
```

### 4. Migrações

```bash
pnpm db:migrate
```

O comando usa `MIGRATION_DATABASE_URL` (papel dono). Recusa a execução se a variável não estiver definida. Cada arquivo roda em uma transação, e o checksum SHA-256 de cada arquivo é gravado em `schema_migrations`. Se um arquivo já aplicado for alterado, o comando para com erro.

Saída esperada na primeira instalação: `migração aplicada` para `0001_base.sql` a `0004_functions.sql`, e `Migrações aplicadas: 4; já existentes: 0.`

### 5. Operador da plataforma

```bash
node apps/api/dist/cli.js platform:create-admin --email operador@seu-dominio.exemplo --name "Nome do operador"
```

- Se `CONCILIA_ADMIN_PASSWORD` estiver definida, ela vira a senha do operador.
- Se não estiver, o comando gera uma senha temporária, mostra uma única vez e marca a conta para troca no primeiro acesso.

### 6. Primeira empresa

```bash
node apps/api/dist/cli.js tenant:create \
  --slug minha-empresa \
  --trade-name "Minha Empresa" \
  --legal-name "Minha Empresa Ltda" \
  --plan profissional \
  --admin-email admin@minha-empresa.exemplo \
  --admin-name "Administrador" \
  --tax-id 00000000000100 \
  --active
```

- `--plan` aceita `essencial`, `profissional` ou `corporativo`, os planos gravados pela migração 0001.
- `--tax-id` é opcional. O comando remove caracteres não numéricos.
- Sem `--active`, a empresa fica em `onboarding` até o próprio administrador concluir o cadastro.
- O comando cria papéis, configurações padrão e o primeiro administrador. Se o administrador não tiver senha definida, a senha temporária é mostrada uma vez.

### 7. Subir a API

```bash
WEB_DIST_DIR=$(pwd)/apps/web/dist node --env-file=.env apps/api/dist/main.js
```

Por padrão a API já executa o trabalhador no mesmo processo (`WORKER_ENABLED=true`).

### 8. Trabalhador em processo separado (opcional)

Para separar a fila da API:

1. Defina `WORKER_ENABLED=false` no `.env` da API.
2. Suba o trabalhador com o mesmo `.env`:

```bash
node --env-file=.env apps/api/dist/worker-main.js
```

O trabalhador recusa começar se o papel do banco tiver superusuário ou `BYPASSRLS` (`assertSafeRuntimeRole` em `apps/api/src/db/context.ts`). Ele não expõe endpoint de métricas: os contadores de trabalhos (`concilia_jobs_processed_total` e `concilia_job_duration_seconds`) ficam só no processo do trabalhador. Os medidores de fila (`concilia_jobs_in_queue` e `concilia_jobs_oldest_queued_seconds`) são lidos do banco pela API.

### 9. Conferir

```bash
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
```

- `/healthz` responde `{"status":"ok"}` se o processo está de pé. Não verifica o banco.
- `/readyz` responde 200 com `{"status":"ok","database":"ok","schema":"ok"}`. Responde 503 se o banco não responder ou se a versão do esquema for diferente da esperada.

## Instalação com Docker Compose

> **Não executado no ambiente de desenvolvimento deste projeto, onde não há Docker.** Os passos abaixo seguem os arquivos `ops/Dockerfile` e `ops/docker-compose.yml`, mas não foram testados nesta máquina.

1. Crie o `.env` na raiz, a partir de `.env.example`. Em `DATABASE_URL` e `MIGRATION_DATABASE_URL`, troque `localhost` por `db`. Defina também `POSTGRES_PASSWORD`, usada pelo superusuário do contêiner `db`.
2. Os valores de `${POSTGRES_PASSWORD}` são lidos pelo Compose do arquivo `.env` do diretório do projeto, que é `ops/`. Para usar o `.env` da raiz, passe `--env-file .env` em cada comando.
3. Crie os papéis e o banco. O serviço `db` não publica porta para o host, então o bootstrap precisa rodar dentro do contêiner, por exemplo copiando `ops/db-bootstrap.sh` para o contêiner com `docker compose cp` e executando-o com `docker compose exec` e as variáveis `DB_OWNER_PASSWORD` e `DB_APP_PASSWORD`. Outra opção é publicar a porta temporariamente.
4. Suba os serviços:

```bash
docker compose --env-file .env -f ops/docker-compose.yml up -d --build
```

Ordem dos serviços:

- `db`: PostgreSQL 16, com verificação de saúde por `pg_isready`.
- `migrate`: roda `node apps/api/dist/cli.js db:migrate` e encerra. O serviço `app` só sobe depois que ele termina com sucesso.
- `app`: roda `node apps/api/dist/main.js` na porta 3000 e tem verificação de saúde em `/healthz`. O trabalhador roda dentro do `app`, pois `WORKER_ENABLED` vem `true` do `.env`.

O `.dockerignore` deixa `.env*` fora da imagem. As variáveis chegam aos serviços pelo `env_file` do Compose.

Para criar o operador e a empresa, use `docker compose ... exec app node apps/api/dist/cli.js ...` com os mesmos comandos da seção sem Docker.

## Modos de implantação (`DEPLOYMENT_MODE`)

- **`multi`** (padrão): várias empresas na mesma instalação. Cada empresa é criada com `tenant:create`. Todas são isoladas por RLS.
- **`single`**: instalação dedicada a uma empresa. A criação de empresa é recusada se já existir uma (`modules/tenancy/provisioning.ts`). A API expõe o modo ao front-end na resposta de autenticação.

O modo é lido no início do processo. Trocar o valor exige reiniciar a API.

## Empresa de demonstração

```bash
DEMO_PASSWORD='senha-para-os-usuarios-de-demo' node apps/api/dist/cli.js demo:seed
```

- Cria a empresa `demo` ("Comércio Exemplo Ltda") com quatro usuários: `admin`, `gestor`, `analista` e `auditor`, todos em `@demo.exemplo.test`. A senha dos quatro é `DEMO_PASSWORD`.
- Gera arquivos fictícios (`apps/api/src/demo/files.ts`), importa-os e executa a conciliação. Imprime o resultado de cada importação e de cada conta.
- Se a empresa `demo` já existir, o comando não altera nada.
- Os dados são fictícios. Não use este comando em uma instalação com dados reais de clientes. Recomendação deste guia, não verificada por teste automatizado.

## Atualização de versão

### Regras

- **Migrações são só para frente.** Não há arquivo de reversão (`down`). Uma migração aplicada nunca é editada: se precisar corrigir, cria-se uma nova, `000N_nome.sql`. O executor recusa a execução se um arquivo já aplicado mudar (checksum diferente).
- **Reversão é por restauração de backup.** Não existe reversão de esquema. Para voltar à versão anterior, restaura-se o backup feito antes da atualização e volta-se o código para a versão antiga. Tudo que foi gravado depois do backup é perdido.
- Até a primeira publicação, as migrações 0001 a 0004 ainda podem ser ajustadas, conforme `CLAUDE.md`. Depois disso, a regra acima vale sem exceção.

### Passos

1. **Backup.** Com acesso ao banco pelo papel dono:

   ```bash
   MIGRATION_DATABASE_URL='postgres://concilia_owner:...@host:5432/concilia' ./ops/backup.sh
   ```

   Anote o caminho do arquivo e o SHA-256 impressos.

2. **Parar** a API e o trabalhador, para que nenhuma escrita ocorra durante a migração. Com Docker: `docker compose -f ops/docker-compose.yml stop app`.

3. **Atualizar o código** para a versão nova (checkout da tag ou do commit de release). Depois:

   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   ```

4. **Migrações:**

   ```bash
   pnpm db:migrate
   ```

   Com Docker, o serviço `migrate` faz esse passo ao subir a stack.

5. **Subir** a API e, se estiver em processo separado, o trabalhador.

6. **Conferir:**

   ```bash
   curl -fsS http://127.0.0.1:3000/readyz
   ```

   Deve responder 200 com `"schema":"ok"`. Se responder 503 com `"schema":"outdated"`, a migração não foi aplicada: volte ao passo 4. Confira também `/healthz` e os logs de erro. Por fim, verifique a trilha: `node apps/api/dist/cli.js audit:verify --platform`.

Se a atualização falhar no passo 4 ou 6 e não houver correção rápida, siga a reversão: pare os processos, restaure o backup com `ops/restore.sh` (ver `docs/08-operacao-backup-recuperacao.md`), volte o código à versão anterior e suba os processos.

## Variáveis de ambiente

Valores padrão e intervalos vêm de `apps/api/src/config/env.ts`. A coluna "No `.env.example`" indica se o modelo traz a variável.

| Variável | Padrão no código | Intervalo / formato | Descrição | No `.env.example` |
|---|---|---|---|---|
| `NODE_ENV` | `development` | `development`, `test`, `production` | Ambiente de execução. Em `production` aplicam-se as travas de segurança. | sim |
| `HOST` | `0.0.0.0` | endereço | Endereço de escuta do servidor HTTP. | sim |
| `PORT` | `3000` | 1 a 65535 | Porta do servidor HTTP. | sim |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | Nível de log. | sim |
| `PRODUCT_NAME` | `Concilia` | 1 a 60 caracteres | Nome exibido na interface e nos relatórios. | sim |
| `DEPLOYMENT_MODE` | `multi` | `multi`, `single` | Várias empresas ou uma empresa só. | sim |
| `DATABASE_URL` | obrigatória | URL do PostgreSQL | Conexão do papel da aplicação (`concilia_app`). Sujeita a RLS. | sim |
| `MIGRATION_DATABASE_URL` | vazio | URL do PostgreSQL | Conexão do papel dono (`concilia_owner`). Usada por migrações e backup. Obrigatória para `db:migrate`. | sim |
| `DB_APP_ROLE` | `concilia_app` | nome do papel | Papel da aplicação, usado pelas migrações para conceder privilégios. | sim |
| `DB_POOL_MAX` | `10` | 1 a 100 | Conexões máximas no pool. | sim |
| `SESSION_SECRET` | obrigatória | mínimo 32 caracteres | Segredo do token CSRF das sessões (HMAC). | sim |
| `SECRETS_MASTER_KEY` | obrigatória | 32 bytes em base64 | Chave mestra para cifrar segredos. Ver a nota abaixo. | sim |
| `SECRETS_KEY_VERSION` | `1` | 1 a 255 | Versão da chave mestra. Ver a nota abaixo. | sim |
| `SECRETS_PREVIOUS_MASTER_KEY`, `SECRETS_PREVIOUS_KEY_VERSION` | vazio | 32 bytes em base64; 1 a 255 | Chave anterior, só durante a troca da chave mestra (`docs/09-seguranca-lgpd.md`, seção 7). | sim |
| `COOKIE_SECURE` | `true` | `true` ou `false` | Cookie só por HTTPS. Obrigatório `true` em produção. | sim, com `false` |
| `SESSION_ABSOLUTE_HOURS` | `12` | 1 a 720 | Validade máxima da sessão, em horas. | sim |
| `LOGIN_MAX_ATTEMPTS` | `5` | 3 a 20 | Tentativas erradas, por conta e origem (IP), antes de a origem passar a esperar 30 s, que dobram a cada nova falha. Outras origens não são afetadas. | sim |
| `LOGIN_LOCK_MINUTES` | `15` | 1 a 1440 | Teto da espera de uma origem, em minutos. | sim |
| `PASSWORD_SCRYPT_COST` | `17` | 10 a 20 (log2 do custo) | Custo do scrypt. Em produção, 15 ou mais. | sim |
| `RATE_LIMIT_ENABLED` | `true` | `true` ou `false` | Limite de requisições por IP. Use `false` só para depuração. | sim |
| `TRUST_PROXY` | `false` | `false`, número de proxies (1 a 10) ou lista de redes (`10.0.0.0/8,127.0.0.1`) | Proxies cujo `X-Forwarded-For` é aceito; o IP do cliente vem do primeiro salto não confiável. `true` é recusado (permitiria forjar o IP). **Obrigatório definir em produção.** O proxy precisa acrescentar o IP de quem conectou ao `X-Forwarded-For`. | sim |
| `WORKER_ENABLED` | `true` | `true` ou `false` | Executa os trabalhos da fila dentro do processo da API. | sim |
| `WORKER_POLL_MS` | `1000` | 100 a 60000 | Intervalo entre consultas da fila, em milissegundos. | sim |
| `WORKER_CONCURRENCY` | `2` | 1 a 16 | Trabalhos executados em paralelo. | sim |
| `JOB_TIMEOUT_SECONDS` | `600` | 30 a 86400 | Tempo máximo de um trabalho antes de ser devolvido à fila ou encerrado. | sim |
| `MAX_UPLOAD_MB` | `15` | 1 a 100 | Tamanho máximo de um arquivo enviado, em MB. | sim |
| `MAX_IMPORT_ROWS` | `100000` | 100 a 500000 | Linhas máximas aceitas em uma importação. | sim |
| `ALLOW_PRIVATE_INTEGRATION_HOSTS` | `false` | `true` ou `false` | Permite integrações com endereços privados. Recusado em produção. | sim |
| `METRICS_TOKEN` | vazio | texto | `/metrics` exige `Authorization: Bearer <token>`. Obrigatório em produção, com 16 caracteres ou mais. | sim |
| `WEB_DIST_DIR` | vazio | caminho | Pasta com o build do front-end servido pela API. Vazio desliga. | sim |

Variáveis lidas fora de `env.ts`:

| Variável | Quem lê | Descrição |
|---|---|---|
| `MIGRATIONS_DIR` | `apps/api/src/db/migrate.ts` | Pasta das migrações. O padrão é `apps/api/migrations`, ou a pasta relativa ao `dist`. A imagem Docker define `/app/apps/api/migrations`. |
| `CONCILIA_ADMIN_PASSWORD` | `cli.ts` (`platform:create-admin`) | Senha do operador da plataforma. Sem ela, gera senha temporária. |
| `DEMO_PASSWORD` | `cli.ts` (`demo:seed`) | Senha dos quatro usuários de demonstração. Obrigatória. |
| `BACKUP_DATABASE_URL` | `ops/backup.sh` | Conexão de backup. Tem prioridade sobre `MIGRATION_DATABASE_URL`. |
| `CONFIRM` | `ops/restore.sh` | Precisa ser `sim` para a restauração executar. |
| `RESTORE_DATABASE_URL` | `ops/restore.sh` | Banco de destino da restauração. Obrigatória. |
| `DB_OWNER_ROLE`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `DB_NAME` | `ops/db-bootstrap.sh` | Papéis e nome do banco criados pelo bootstrap. As senhas são obrigatórias. |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` | `ops/db-bootstrap.sh` (padrões do `psql`) | Conexão do administrador do PostgreSQL. |
| `POSTGRES_PASSWORD` | `ops/docker-compose.yml` | Senha do superusuário do contêiner `db`. Obrigatória com Docker. |

Notas:

- **`SECRETS_MASTER_KEY` e `SECRETS_KEY_VERSION`**: a configuração as lê e valida, mas o código do repositório não tem a rotina de cifra que as usaria. A coluna `integrations.secret_ciphertext` existe no esquema, e o esquema prevê AES-256-GCM, porém não há implementação no código atual. Ver `docs/08-operacao-backup-recuperacao.md`.
- **`COOKIE_SECURE`**: o padrão do código é `true`, mas o `.env.example` traz `false`, para desenvolvimento. Em produção, mantenha `true`.
- **`SESSION_SECRET`**: o código usa o valor para gerar o token CSRF de cada sessão. Trocar o valor invalida esses tokens, então as abas abertas precisam ser recarregadas.
