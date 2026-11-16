# 08. Operação, backup e recuperação

Este documento reúne a rotina de operação do Concilia: backup e restauração, verificação de saúde, métricas e alertas, fila de trabalhos, trilha de auditoria, rotação de segredos e falhas comuns.

Os comandos assumem a raiz do projeto como diretório atual.

## Backup

### Como gerar

```bash
MIGRATION_DATABASE_URL='postgres://concilia_owner:...@host:5432/concilia' ./ops/backup.sh
```

- Usa `BACKUP_DATABASE_URL` se estiver definida; senão, `MIGRATION_DATABASE_URL`. Sem nenhuma das duas, o script para.
- Roda `pg_dump --format=custom` e grava `backups/concilia-AAAAMMDD-HHMMSS.dump` na raiz do projeto. A pasta `backups/` é ignorada pelo git e excluída do contexto do Docker.
- Imprime o caminho do arquivo e o SHA-256. Guarde o hash junto ao arquivo para conferir a integridade antes de restaurar.
- O nome usa segundos. Dois backups no mesmo segundo gravam no mesmo arquivo.

### Pontos de atenção

- **O dump contém todos os dados**: hashes de senha, hashes de sessão e de token de API, conteúdo dos arquivos importados (`import_files`) e configurações de integração, com os segredos já cifrados (`secret_ciphertext`). Os segredos só decifram com a `SECRETS_MASTER_KEY` da versão em que foram gravados: guarde a chave (e as chaves antigas, enquanto houver backup que dependa delas) separada do dump. O dump em si não é cifrado pelo script. Proteja o arquivo e controle o acesso à pasta `backups/`.
- **Não há rotação nem retenção**. O script não apaga backups antigos e não há agendamento no repositório. A periodicidade e a retenção precisam ser configuradas fora do projeto (por exemplo, cron ou agendador do servidor).
- **Destino fixo**: o script sempre grava em `<raiz>/backups/`. Para outro destino, copie o arquivo depois.

### Como restaurar

```bash
CONFIRM=sim RESTORE_DATABASE_URL='postgres://concilia_owner:...@host:5432/concilia_restore_check' \
  ./ops/restore.sh backups/concilia-AAAAMMDD-HHMMSS.dump
```

- `CONFIRM=sim` é obrigatório. Sem ele, o script recusa a execução.
- Usa `pg_restore --clean --if-exists --no-owner --exit-on-error`. A opção `--clean` apaga os objetos que já existem no destino antes de recriá-los. **Restaure em banco vazio ou em banco que pode ser sobrescrito.**
- O banco de destino precisa existir. O script não o cria.
- `--no-owner` faz os objetos pertencerem ao papel que conecta. Os `GRANT` do dump são restaurados, mas o papel `concilia_app` precisa existir antes da restauração. Este ponto não foi verificado no teste abaixo.

### Recomendação

Teste a restauração periodicamente em um banco separado, não só na primeira instalação. O teste desta seção pode servir de modelo.

## Teste executado

Nota: este teste foi feito quando existiam quatro migrações. O repositório hoje tem seis (`0005_integrations.sql` e `0006_retention.sql`); um banco novo aplica as seis e `schema_migrations` terá seis linhas. As operações `secrets:rotate`, `tenant:export` e `tenant:purge` e o expurgo por retenção não fazem parte deste teste.

Teste de backup e restauração feito no ambiente de desenvolvimento deste projeto, em 16/11/2026, com o PostgreSQL 16 local (`main`, porta 5432). Os comandos e resultados abaixo são os reais.

Sequência e resultados:

| Passo | Comando | Resultado |
|---|---|---|
| 1 | `pg_lsclusters` | Cluster `16 main`, porta 5432, situação `online`. Não foi necessário iniciar. |
| 2 | `pnpm --filter @concilia/api cli db:migrate` | Quatro migrações aplicadas (`0001_base.sql` a `0004_functions.sql`). Saída: `Migrações aplicadas: 4; já existentes: 0.` Código de saída 0. |
| 3 | `./ops/backup.sh` | Gerou `backups/concilia-20261116-110405.dump` (156 036 bytes). SHA-256 `508c1fa957548c634a2060cad656eb645e0d04bea0994de6894343a20cd1db31`. Código de saída 0. |
| 4 | `createdb ... -O concilia_owner concilia_restore_check` | Banco de verificação criado. Código de saída 0. |
| 5 | `CONFIRM=sim RESTORE_DATABASE_URL=... ./ops/restore.sh backups/concilia-20261116-110405.dump` | `Restauração concluída a partir de: backups/concilia-20261116-110405.dump`. Código de saída 0. |
| 6 | Comparação entre os dois bancos | Ver abaixo. |
| 7 | `dropdb concilia_restore_check` | Banco de verificação removido. Código de saída 0. |

Comparação entre `concilia` (origem) e `concilia_restore_check` (destino restaurado):

- **Tabelas públicas (`BASE TABLE`)**: 31 nos dois bancos. A lista de nomes é idêntica (comparada com `diff`, sem diferença).
- **`schema_migrations`**: 4 linhas nos dois bancos, com nomes, checksums e `applied_at` idênticos:
  - `0001_base.sql`, checksum `d084b23f...`
  - `0002_config.sql`, checksum `c07f43af...`
  - `0003_data.sql`, checksum `c7b27d82...`
  - `0004_functions.sql`, checksum `1ba9c35d...`

Observações do teste, sem maquiagem:

- Uma primeira consulta de comparação falhou por erro meu: usei a coluna `version`, que não existe em `schema_migrations` (as colunas são `name`, `checksum` e `applied_at`). Refiz a consulta com as colunas corretas. A falha não veio de nenhum script do `ops/`.
- O banco `concilia` estava vazio antes do passo 2: as quatro migrações foram aplicadas nessa execução. Por isso o teste não cobriu um banco com dados de empresa. A comparação feita foi de estrutura e de migrações, não de quantidade de linhas.
- Não foi verificado o acesso do papel `concilia_app` após a restauração (os `GRANT` no banco restaurado).
- Não foram encontrados defeitos nos scripts `ops/backup.sh` e `ops/restore.sh` que impedissem o teste. Os pontos de atenção descritos acima (sem cifra, sem retenção, destino fixo e nome por segundo) são limitações, não falhas do teste.
- O arquivo `backups/concilia-20261116-110405.dump` permanece na pasta `backups/` deste ambiente. Ele tem o banco de desenvolvimento e pode ser removido.

## Verificação de saúde

| Endpoint | Autenticação | O que verifica | Resposta |
|---|---|---|---|
| `GET /healthz` | nenhuma | Processo da API de pé. Não toca no banco. | `200 {"status":"ok"}` |
| `GET /readyz` | nenhuma | Conexão com o banco (`SELECT 1`) e versão do esquema igual à última migração da pasta de migrações. | `200 {"status":"ok","database":"ok","schema":"ok"}`; ou `503` com `"status":"unavailable"` e os campos `database` (`ok` ou `error`) e `schema` (`ok`, `outdated` ou `unknown`) |
| `GET /metrics` | `Authorization: Bearer <METRICS_TOKEN>`; em produção a API não sobe sem o token (fora de produção, sem token, aberto) | Formato Prometheus. | Texto Prometheus, ou `401` com token ausente ou errado |

O `/readyz` é o endpoint para o balanceador e para as verificações de implantação. O `/healthz` serve para saber se o processo responde, sem depender do banco.

## Métricas

Definidas em `apps/api/src/observability/metrics.ts`. Todas têm o prefixo `concilia_`.

| Métrica | Tipo | Rótulos | Significado |
|---|---|---|---|
| `concilia_http_request_duration_seconds` | histograma | `method`, `route`, `status` | Duração das requisições HTTP. |
| `concilia_jobs_processed_total` | contador | `type`, `result` | Trabalhos processados, por tipo e resultado. |
| `concilia_job_duration_seconds` | histograma | `type` | Duração dos trabalhos. |
| `concilia_import_rows_total` | contador | `source`, `result` | Linhas de importação, por origem e resultado. |
| `concilia_reconciliation_matches_total` | contador | `decision` | Resultados do motor de conciliação, por decisão. |
| `concilia_login_attempts_total` | contador | `result` | Tentativas de login. Valores gravados: `success`, `invalid`, `locked`, `disabled`. |
| `concilia_integration_calls_total` | contador | `kind`, `result` | Chamadas a serviços externos, por tipo e resultado. |
| `concilia_jobs_in_queue` | medidor | `status` | Trabalhos por situação (`queued`, `running`, `dead`). Lido do banco a cada coleta. |
| `concilia_jobs_oldest_queued_seconds` | medidor | nenhum | Idade, em segundos, do trabalho mais antigo aguardando. Lido do banco. |

Ressalvas:

- Os contadores de trabalho (`concilia_jobs_processed_total` e `concilia_job_duration_seconds`) são registrados no processo que executa o trabalho. Se o trabalhador roda em processo separado (`worker-main.js`), esses contadores não aparecem no `/metrics` da API. Os medidores de fila não têm esse problema, porque leem o banco.
- A aplicação não ativa as métricas padrão do Node neste processo do trabalhador (`createMetrics(pool, false)`).

## Alertas

Regras de exemplo em `ops/alerts.yml`, para Prometheus. Os limiares devem ser ajustados ao volume de cada instalação.

| Alerta | Condição | Gravidade | Ação inicial |
|---|---|---|---|
| `ConciliaTrabalhoMorto` | `concilia_jobs_in_queue{status="dead"} > 0` por 5 min | warning | Ver a causa do trabalho morto antes de repetir (ver seção de fila). |
| `ConciliaTrabalhoAguardandoMuitoTempo` | `concilia_jobs_oldest_queued_seconds > 600` por 5 min | critical | Verificar se o trabalhador está rodando. |
| `ConciliaErrosHttp5xxAlto` | mais de 5% das requisições com 5xx em 5 min | critical | Ver os logs da API e o estado do banco. |
| `ConciliaLatenciaP95Alta` | p95 acima de 2 s por 10 min | warning | Ver consultas lentas e a carga do banco. |
| `ConciliaPicoDeFalhasDeLogin` | mais de 50 tentativas com `result != "success"` em 10 min | warning | Possível ataque de senha. Ver os logs de autenticação. |

O alerta de falhas de login conta `invalid`, `locked` e `disabled` como falha, que são os valores gravados pelo código.

## Fila de trabalhos

### Situações

Tabela `jobs`, coluna `status`:

- `queued`: aguardando execução (`run_at` indica quando).
- `running`: em execução, com `locked_by` e `locked_at`.
- `succeeded`: concluído, com `result`.
- `dead`: esgotou as tentativas. Não é repetido automaticamente.
- `canceled`: cancelado.

Cada tipo de trabalho tem chave de idempotência por empresa (`UNIQUE (tenant_id, type, idempotency_key)`). Enfileirar a mesma operação de novo devolve o trabalho existente.

### Repetição automática

- Cada trabalho tem `max_attempts` (padrão 3, de 1 a 20).
- Em falha, se `attempts < max_attempts`, o trabalho volta a `queued` com espera de `2^tentativas × 5 s`, limitada a 10 minutos. Com o padrão, há duas repetições: a primeira após 10 s e a segunda após 20 s.
- Quando as tentativas se esgotam, o trabalho vai para `dead`, com `finished_at` preenchido. A auditoria registra `job.dead`, e é gerada uma notificação dentro do sistema para os usuários ativos com a permissão `settings.manage` da empresa.

### Trabalho travado

Se um trabalhador para no meio de uma execução, o trabalho fica `running` com `locked_at` antigo. A cada ciclo do trabalhador, a função `jobs_release_stale` procura trabalhos `running` cujo `locked_at` é mais antigo que `JOB_TIMEOUT_SECONDS`. Esses trabalhos voltam a `queued` ou, se já esgotaram as tentativas, vão para `dead` com o erro `Trabalhador não concluiu no tempo limite`.

### Reprocessar

- **Trabalho `dead`, `succeeded` ou `canceled`**: `POST /api/v1/jobs/:id/retry`. A rota devolve o trabalho à fila com `attempts` zerado. Só funciona se o trabalho estiver nessas situações; trabalho `queued` ou `running` responde conflito.
- **Importação concluída ou falha**: `POST /api/v1/imports/:id/reprocess`. Só funciona para importações `completed` ou `failed`.
- **Antes de repetir um trabalho morto**, veja a causa em `last_error`. Repetir sem corrigir a causa leva ao mesmo `dead`.

### Consultas de diagnóstico

Como o papel da aplicação é restrito por RLS, o diagnóstico de fila geral usa a função de contagens, que não expõe dados de empresa:

```sql
SELECT * FROM ops_queue_stats();
```

Para listar trabalhos mortos, use o papel dono (`concilia_owner`), que é dono da tabela e, por padrão do PostgreSQL, não está sujeito a RLS:

```sql
SELECT id, tenant_id, type, attempts, last_error, finished_at
  FROM jobs WHERE status = 'dead' ORDER BY finished_at DESC;
```

Esse acesso mostra dados de todas as empresas. Use-o apenas quando necessário.

## Trilha de auditoria

Verificação da cadeia de hashes de uma empresa ou da plataforma:

```bash
node apps/api/dist/cli.js audit:verify --tenant minha-empresa
node apps/api/dist/cli.js audit:verify --platform
```

- Imprime um JSON com `scope`, `intact`, `checked`, `brokenSeq`, `headSeq` e `headHash`.
- Código de saída `0`: cadeia íntegra. Código `2`: cadeia quebrada, na sequência `brokenSeq`. Outro código: erro de execução.
- A verificação não altera nada. Se a cadeia estiver quebrada, preserve o banco e investigue antes de qualquer restauração.

Limite: a verificação confere se as linhas restantes formam uma cadeia consistente. Ela não detecta a remoção da última linha de uma cadeia. Para esse caso, registre o `headHash` fora do banco em intervalos regulares. O repositório não faz esse registro.

Teste feito neste ambiente: `audit:verify --platform` respondeu `intact: true`, `checked: 0` e saiu com código 0. A cadeia da plataforma estava vazia, pois o banco de desenvolvimento ainda não tinha eventos da plataforma. Para executar o comando, a CLI carrega a configuração completa; no teste, foram usados valores locais de teste para as variáveis de segredo, não os de produção.

## Rotação de segredos

| Segredo | O que protege | Como trocar | Situação |
|---|---|---|---|
| `SESSION_SECRET` | Gera o token CSRF de cada sessão (HMAC). As sessões em si não dependem dele: o token da sessão é aleatório e só o hash SHA-256 fica no banco. | Gere novo valor (`openssl rand -hex 32`), atualize o `.env` e reinicie a API. | Automatizado só no sentido de ser lido da configuração. Efeito: as abas abertas recebem erro de CSRF e precisam ser recarregadas. As sessões continuam válidas. |
| `SECRETS_MASTER_KEY` | Cifra os segredos de integração (AES-256-GCM, `apps/api/src/security/secrets.ts`). | `secrets:rotate` (seção abaixo). | Implementado. |
| `SECRETS_KEY_VERSION` | Versão da chave mestra, gravada no primeiro byte de cada segredo cifrado e em `integrations.secret_key_version`. | Muda junto com a chave, ao fim do `secrets:rotate`. | Implementado. |
| `METRICS_TOKEN` | Acesso ao `/metrics`. | Defina novo valor, reinicie a API e atualize o coletor do Prometheus. | Manual. Não há comando no repositório. |
| Senha do papel `concilia_app` | Conexão da aplicação ao banco. | `ALTER ROLE concilia_app PASSWORD '...';` como superusuário, depois atualize `DATABASE_URL` e reinicie a API e o trabalhador. | Manual. |
| Senha do papel `concilia_owner` | Migrações e backup. | `ALTER ROLE concilia_owner PASSWORD '...';`, depois atualize `MIGRATION_DATABASE_URL` e `BACKUP_DATABASE_URL`, se houver. | Manual. |
| `CONCILIA_ADMIN_PASSWORD`, `DEMO_PASSWORD` | Senha inicial do operador da plataforma e dos usuários de demonstração. | Não são guardadas: são lidas no momento do comando da CLI. | Não se aplica a rotação. |
| Tokens de API (prefixo `ck_`) | Entrada de lançamentos pela API. | O banco guarda o hash SHA-256 (`token_hash`) e o prefixo, nunca o token. A coluna `revoked_at` marca a revogação. A criação e a revogação são rotas de `apps/api/src/modules/api-tokens/routes.ts` (permissão `integrations.manage`). | Manual, token a token. O código não tem comando de rotação em massa. |

Não há comando para trocar a senha de todos os usuários de uma vez.

### Troca da chave mestra (`secrets:rotate`)

Recifra todos os segredos de `integrations` com uma chave nova, em uma única transação (`apps/api/src/ops/secrets-rotate.ts`).

Pré-condições:

- `MIGRATION_DATABASE_URL` (papel dono do esquema): a operação cruza empresas.
- `SECRETS_MASTER_KEY` com a chave atual, `NEW_SECRETS_MASTER_KEY` (32 bytes em base64, `openssl rand -base64 32`) e `NEW_SECRETS_KEY_VERSION` (inteiro de 1 a 255, diferente da versão atual).
- Backup recente do banco. Guarde a chave antiga até confirmar que tudo funciona com a nova.

```bash
NEW_SECRETS_MASTER_KEY=... NEW_SECRETS_KEY_VERSION=2 node apps/api/dist/cli.js secrets:rotate
```

Comportamento:

- Trava as linhas com segredo (`FOR UPDATE`): gravações concorrentes de segredo esperam o fim da troca.
- Decifra cada segredo com a chave atual, cifra com a nova e decifra de volta para conferir antes de gravar. Segredos já na versão nova são pulados, depois de conferir que decifram com a chave nova.
- Se algum segredo não decifrar (chave atual errada, dado corrompido), a operação inteira é cancelada e nada é alterado. A mensagem cita ids de integração, nunca o segredo.
- Grava auditoria `integration.secrets_rotated` em cada empresa afetada e `platform.secrets_rotated` na trilha da plataforma.

Depois do comando, **a API e o trabalhador continuam com a chave antiga na memória e não conseguem mais decifrar os segredos**. Troque `SECRETS_MASTER_KEY` pela chave nova e `SECRETS_KEY_VERSION` pela versão nova no `.env` e reinicie a API e o trabalhador. Até lá, testes de integração, envio de webhook e e-mail, conector e IA falham. Faça a troca em janela combinada.

## Retenção de arquivos originais

- Cada empresa escolhe `imports.originalFileRetentionDays` (30 a 3650 dias; vazio desliga) nas configurações.
- O trabalhador (`apps/api/src/jobs/worker.ts`, `apps/api/src/jobs/maintenance.ts`) verifica a cada hora e enfileira, no máximo uma vez por dia por empresa, o trabalho `maintenance.purge_import_files`. Ele roda só onde há trabalhador ativo (`WORKER_ENABLED=true` na API ou processo `worker-main.js`).
- O trabalho apaga de `import_files` os arquivos de lotes processados há mais dias que a retenção e marca `import_batches.file_purged_at`. Lote, hash e estatísticas permanecem. Grava auditoria `import.files_purged`. Rodar de novo não acha nada.
- Efeito colateral: ações que dependem do arquivo original (como reprocessar o lote) deixam de ser possíveis para lotes expurgados.
- Backups feitos antes do expurgo ainda contêm os arquivos. A retenção dos backups é decisão da instalação.

## Exportação e eliminação de uma empresa

Os dois comandos usam `MIGRATION_DATABASE_URL`, passam por cima do isolamento por empresa e devem ser executados só por quem opera a instalação.

### `tenant:export`

```bash
node apps/api/dist/cli.js tenant:export --tenant minha-empresa --out /caminho/exportacao.ndjson [--include-files]
```

- Gera NDJSON com cabeçalho, uma linha por registro e um resumo com contagens (`apps/api/src/ops/tenant-export.ts`). Lê tudo em uma transação somente leitura de leitura repetível (fotografia consistente).
- Não exporta a tabela `sessions` nem colunas com hash de senha, texto cifrado, hash de token ou valor de segredo.
- `--include-files` inclui o conteúdo de `import_files` em base64; sem ela, os arquivos originais ficam de fora.
- Não sobrescreve arquivo existente. O arquivo é criado com permissão 0600. Se a exportação falhar no meio, o arquivo parcial é removido.
- Grava auditoria `tenant.data_exported` na trilha da empresa.
- O arquivo contém dados pessoais e financeiros sem cifra: proteja o destino e apague quando cumprir a finalidade.

### `tenant:purge`

```bash
node apps/api/dist/cli.js tenant:purge --tenant minha-empresa --confirm minha-empresa
```

- Só elimina empresa **arquivada** (`status = archived`); caso contrário recusa. Exige repetir o slug em `--confirm`.
- Apaga, em uma transação, todas as linhas de todas as tabelas com `tenant_id` (descobertas pelo catálogo) e a linha da empresa, inclusive registros de origem e a trilha de auditoria da empresa. Para isso, desabilita dentro da transação os gatilhos que barram `DELETE` e os reabilita antes do `COMMIT`. Confere que nada restou; se restar, desfaz tudo.
- É irreversível. Antes: `tenant:export`, backup, e confirmação de quem responde pela empresa.
- Ressalvas operacionais:
  - O `ALTER TABLE ... DISABLE TRIGGER` trava as tabelas até o fim da transação. **Gravações de todas as empresas nessas tabelas esperam**, e a eliminação desiste após 30 s de espera por travas (`lock_timeout`). Execute em janela de baixo uso.
  - **Registros da trilha da plataforma que citam nome, slug e CNPJ da empresa não são apagados** (têm `tenant_id` nulo). A eliminação grava ainda `platform.tenant_purged`, só com o identificador da empresa e contagens.
  - Backups anteriores continuam com os dados da empresa até serem descartados pela política da instalação.

Detalhes de LGPD em `docs/09-seguranca-lgpd.md`.

## Falhas comuns

### Banco fora do ar

- **Sintoma**: `/readyz` responde 503 com `"database":"error"`. Requisições respondem `internal_error`. O log registra `verificação de prontidão falhou`.
- **Ação**: verifique o serviço do PostgreSQL (no ambiente local, `pg_lsclusters`; se estiver `down`, `pg_ctlcluster 16 main start`). Confira `DATABASE_URL` e a rede até o banco.
- **Depois**: confirme `/readyz` com 200. Se as requisições continuarem falhando com o banco de pé, reinicie a API e o trabalhador (não verificado se o pool se recupera sozinho).

### Migração pendente

- **Sintoma**: `/readyz` responde 503 com `"schema":"outdated"`. A API sobe, mas os recursos da versão nova podem falhar.
- **Ação**: rode `pnpm db:migrate` com `MIGRATION_DATABASE_URL` apontando para o papel dono.
- **Se o comando recusar** com `já foi aplicada e depois alterada (checksum diferente)`: alguém editou um arquivo de migração já aplicado. Não altere o banco à mão. Restaure o arquivo original a partir do controle de versão e, se for preciso mudar o esquema, crie uma nova migração.

### Fila parada

- **Sintoma**: alerta `ConciliaTrabalhoAguardandoMuitoTempo`, com trabalhos `queued` cuja idade cresce.
- **Verificar**:
  - O trabalhador está rodando? Na API com `WORKER_ENABLED=true`, veja o processo da API. Em processo separado, veja o processo `worker-main.js`.
  - Há trabalhos `running` antigos? Veja `locked_at`. Eles devem ser devolvidos após `JOB_TIMEOUT_SECONDS`.
  - Quais as situações? `SELECT * FROM ops_queue_stats();`.
- **Ação**: reinicie o trabalhador se ele estiver parado. Se os trabalhos travarem de novo, veja a causa no log antes de reiniciar em série.

### Disco cheio

- **Sintoma**: erros de escrita no PostgreSQL. Backups falham. A API pode responder erro interno ao gravar.
- **Causas prováveis**: o crescimento de `import_files`, que guarda o conteúdo original dos arquivos, e da trilha `audit_log`. Para `import_files`, a empresa pode configurar a retenção (seção "Retenção de arquivos originais"); sem ela, nada é expurgado. A trilha `audit_log` não tem expurgo.
- **Ação**: libere espaço antes de tudo. Não apague linhas de `audit_log` (a tabela não permite). Antes de qualquer expurgo manual, faça backup.
- **Backup com disco cheio**: o `pg_dump` gera o arquivo na pasta `backups/`. Se faltar espaço, o dump falha e o arquivo parcial deve ser removido antes de tentar de novo.

### Trilha de auditoria quebrada

- **Sintoma**: `audit:verify` sai com código 2.
- **Ação**: não corrija linhas à mão. Preserve o banco, registre a sequência `brokenSeq` e investigue quem tem acesso ao papel dono. Se a integridade não puder ser recuperada, a restauração do último backup íntegro é o caminho.
