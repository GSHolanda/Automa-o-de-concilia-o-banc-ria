# 09. Segurança e LGPD

Este documento descreve os **controles técnicos** que existem no código do Concilia e onde conferi-los. Ele não é parecer jurídico e não afirma que a instalação, a empresa cliente ou o fornecedor estão em conformidade com a LGPD (Lei 13.709/2018). Essa avaliação é de quem opera o produto, com assessoria jurídica. Onde o texto diz "orientação", trata-se de ponto de partida a validar.

Cada controle cita o arquivo do repositório onde ele está. Caminhos são relativos à raiz.

## 1. Papéis no tratamento de dados (orientação)

| Papel | Quem costuma ser | Observação |
|---|---|---|
| Controladora | A empresa cliente | Decide a finalidade e quais extratos, lançamentos e usuários entram no sistema. |
| Operador | Quem fornece e opera o software (hospedagem, atualização, suporte) | Trata os dados conforme as instruções da empresa cliente. |
| Suboperadores | Provedores externos que a empresa cliente liga por conta própria: destino de webhook, servidor SMTP, provedor de IA, API de ERP | Só recebem dados se o módulo correspondente estiver habilitado e a integração configurada. Ver seção 3. |

Em instalação própria da empresa cliente, controladora e operadora são a mesma organização. O contrato, o aviso de privacidade e a base legal de cada tratamento não são definidos pelo software.

## 2. Inventário de dados pessoais

O produto trata dados de conciliação bancária. Dados de pessoas aparecem nos pontos abaixo (esquema em `apps/api/migrations/` e `docs/03-modelo-de-dados.md`).

| Dado | Onde fica | Finalidade |
|---|---|---|
| Nome, e-mail, hash da senha, papel, situação, datas de login, contagem de falhas e bloqueio dos **usuários** | `users` (`0001_base.sql`) | Autenticar, autorizar e identificar quem fez cada ação. |
| **IP e agente de navegador (user agent)** da sessão | `sessions.ip`, `sessions.user_agent` (`0001_base.sql`; gravados em `apps/api/src/modules/auth/routes.ts`) | Listar e revogar sessões; investigar acesso indevido. |
| IP, agente de navegador, id e rótulo do autor, e valores antes/depois das alterações | `audit_log` (`0001_base.sql`; `apps/api/src/audit/audit.ts`; login em `modules/auth/routes.ts`) | Trilha de auditoria. A criação de usuário grava nome e e-mail em `after`. |
| **Nomes de pessoas e empresas em descrições** de extrato e de lançamentos, documento, referência | `bank_transactions` e `ledger_entries`: `description_raw`, `description_norm`, `document`, `reference`, `raw` (`0003_data.sql`) | Conciliar o extrato com o razão. O produto não separa "nome de pessoa" do restante do texto: o que o banco escreve na descrição é guardado. |
| **Favorecido/contraparte** | `ledger_entries.counterparty` (`0003_data.sql`); no extrato bancário não há coluna própria, e o nome do favorecido, quando existe, vem dentro da descrição ou de `bank_transactions.raw` | Conciliação e relatórios. |
| Conteúdo integral dos **arquivos importados** (OFX, CSV, XLSX, JSON) | `import_files.content` (`0003_data.sql`) | Evidência da origem e reprocessamento. Sujeito à retenção (seção 7). |
| Linhas rejeitadas, na forma original | `import_rejections.raw` (`0003_data.sql`) | Permitir corrigir a origem. |
| E-mails de destinatários de avisos | `notification_rules.target` (`0002_config.sql`) e `notification_deliveries.payload` | Enviar avisos por e-mail. A entrega guarda o texto enviado. |
| Razão social, nome fantasia, CNPJ da empresa cliente | `tenants` (`0001_base.sql`) | Identificar a empresa. É dado de pessoa jurídica; pode identificar empresário individual. |
| Nome do arquivo importado e mensagens de erro | `import_batches.file_name`, `jobs.last_error`, notificações internas | Operação. O nome do arquivo é escolhido por quem envia e pode conter um nome. |

Valores e saldos não são dados pessoais por si, mas, ligados a um nome, podem revelar informação financeira de uma pessoa. Trate o banco todo como dado de acesso restrito.

## 3. Minimização

### O que não é coletado

Conferido por busca no código e no esquema:

- Não há conexão bancária, credenciais de banco, número de cartão, CPF de titulares como campo próprio, nem biometria. CNPJ existe apenas para a empresa cliente (`tenants.tax_id`).
- Não há rastreadores, análise de uso nem chamada a serviços de terceiros pelo navegador além dos listados abaixo, que são iniciados pelo servidor.
- A senha em texto nunca é gravada; só o hash (seção 5).

### O que sai para provedores externos

Toda saída passa por `apps/api/src/integrations/http.ts` (`safeFetch`), que só envia a destinos configurados pela empresa.

| Provedor | O que é enviado | Onde conferir |
|---|---|---|
| **IA** (módulo `ai.assist`, adaptador Anthropic) | Por transação: referência local (`t1`, `t2`...), **descrição normalizada**, **sentido** (`in`/`out`) e **tipo**. Por categoria: referência local e **nome da categoria** (nome do cadastro da empresa). Não são enviados identificadores internos, valores, datas, contraparte, documento nem o texto original. Até 100 transações por chamada. O teste da integração envia apenas "Responda apenas: ok". | `apps/api/src/modules/ai/routes.ts` (monta `transactions` e `categoryInputs`), `apps/api/src/integrations/anthropic.ts` (`suggestCategories`) |
| **Webhook** (`notifications.webhook`) | Evento assinado com `id`, `event`, `occurredAt` e `data`. O `data` varia por evento: ids internos, contagens, período, nome do arquivo importado (`import.completed`/`import.failed`), mensagem de erro de até 500 caracteres (`job.dead`) e o id do usuário que propôs uma aprovação. Não leva descrições de transações. | `apps/api/src/integrations/webhook.ts`; conteúdo em `modules/notifications/service.ts`, `modules/imports/process.ts`, `modules/reconciliation/run.ts`, `modules/reconciliation/decisions.ts`, `jobs/worker.ts` |
| **E-mail** (`notifications.email`) | Destinatários da regra, assunto e texto do aviso (os mesmos títulos e mensagens acima, com link interno). | `modules/notifications/service.ts` (`payload` do canal de e-mail), `integrations/smtp.ts` |
| **Conector REST** | Consulta de leitura ao ERP com o período; o segredo vai no cabeçalho de autenticação. Nada do Concilia é enviado ao ERP além dos parâmetros de data. | `apps/api/src/integrations/rest-ledger.ts` |

A resposta da IA é só sugestão: fica em `matches` com `origin = 'ai'` e nunca é confirmada sem uma pessoa (`modules/ai/routes.ts`). O provedor de IA é um suboperador: antes de habilitar, a empresa cliente deve avaliar os termos dele. As integrações só são usadas se o módulo estiver habilitado para a empresa e a integração estiver `verified` (regra em `docs/04-api-e-conectores.md`, seção 9).

## 4. Controle de acesso e isolamento

### Isolamento entre empresas

- **RLS no PostgreSQL.** Toda tabela de dados de empresa tem política `tenant_isolation` (`tenant_id = app_tenant_id()`) para leitura e escrita (`apps/api/migrations/0001_base.sql`, função `_apply_tenant_rls`). Sem contexto de empresa, nenhuma linha é visível. O contexto é definido por transação em `withContext` (`apps/api/src/db/context.ts`).
- **Papel de banco sem privilégio.** A aplicação usa `concilia_app`, sem superusuário, sem `BYPASSRLS` e sem ser dona das tabelas. O dono (`concilia_owner`) só é usado em migração, backup e nos comandos de operação (`docs/03-modelo-de-dados.md`).
- **Verificação na subida.** `assertSafeRuntimeRole` recusa iniciar se o papel for superusuário, tiver `BYPASSRLS` ou for dono de tabelas (`apps/api/src/db/context.ts`; chamada em `apps/api/src/app.ts` e `apps/api/src/worker-main.ts`).
- **Chaves compostas.** As ligações entre tabelas de empresa são `(tenant_id, id)`: o banco recusa ligar registros de empresas diferentes (`0002_config.sql`, `0003_data.sql`).
- **Recurso de outra empresa responde 404**, porque a linha não existe sob RLS.
- **Funções que cruzam empresas** (`SECURITY DEFINER`) são poucas, com `search_path` fixo e concedidas só ao papel da aplicação (`0004_functions.sql`, `0006_retention.sql`; lista em `docs/03-modelo-de-dados.md`).

### Autenticação

- **Senhas:** scrypt com sal aleatório de 16 bytes e comparação em tempo constante; os parâmetros ficam gravados no hash (`apps/api/src/security/password.ts`). Custo configurável (`docs/02-arquitetura.md`, seção 4). Política: tamanho mínimo configurável, máximo de 200, recusa de senha repetitiva e de senha que contém o e-mail (`passwordProblem`).
- **Troca obrigatória** da senha temporária no primeiro acesso (`must_change_password`; `modules/access/routes.ts`, `cli.ts`).
- **Força bruta:** limite de 10 tentativas por minuto na rota de login (`modules/auth/routes.ts`) e bloqueio temporário da conta após `LOGIN_MAX_ATTEMPTS` falhas (padrão 5) por `LOGIN_LOCK_MINUTES` (padrão 15) (`apps/api/src/config/env.ts`; função `auth_register_login_failure` em `0004_functions.sql`). As tentativas falhas entram na auditoria.
- **Sessões:** o cookie leva um token aleatório de 256 bits; o banco guarda só o SHA-256 (`security/tokens.ts`, `sessions.token_hash`). Cookie `HttpOnly`, `SameSite=Lax` e `Secure` conforme configuração (`modules/auth/routes.ts`, `setSessionCookie`). Expira por inatividade e por duração absoluta (`apps/api/src/http/auth.ts`, `SESSION_ABSOLUTE_HOURS`). A troca de senha encerra as outras sessões; o administrador pode revogar as sessões de um usuário (`modules/auth/routes.ts`, `modules/access/routes.ts`).
- **CSRF:** escritas por sessão exigem o cabeçalho `X-CSRF-Token`, um HMAC derivado da sessão e de `SESSION_SECRET`, comparado em tempo constante (`apps/api/src/http/route.ts`, `security/tokens.ts`).
- **Cabeçalhos:** Helmet com CSP restritiva e `frame-ancestors 'none'`; sem CORS por padrão (`apps/api/src/app.ts`).
- Empresa arquivada não permite login (`modules/auth/routes.ts`).

### Autorização

Catálogo de permissões no domínio (`packages/core`), papéis por empresa em `roles`, e cada rota declara a permissão exigida em `route({... permission ...})` (`apps/api/src/http/route.ts`). Exemplos: `audit.view`, `exports.create`, `users.manage`, `integrations.manage`. Rotas de módulo opcional respondem 403 `module_disabled` se o módulo estiver desligado. Rotas da plataforma exigem operador da plataforma.

## 5. Proteção de segredos

- **Cofre.** Segredos de integração (token do conector, senha SMTP, chave de IA, segredo de webhook) são cifrados com **AES-256-GCM** usando `SECRETS_MASTER_KEY` (32 bytes). Formato: versão da chave, IV de 12 bytes, tag de 16, texto cifrado (`apps/api/src/security/secrets.ts`).
- **AAD por empresa.** O dado autenticado adicional é `tenantId:integrationId`: um texto cifrado copiado para outra empresa ou integração não decifra.
- **Versão de chave** gravada em cada segredo (`secret_key_version`).
- **Troca de chave:** `secrets:rotate` recifra tudo em uma transação, confere cada recifra e cancela tudo se algum segredo não decifrar (`apps/api/src/ops/secrets-rotate.ts`). Procedimento e ressalvas na seção 7 e em `docs/08-operacao-backup-recuperacao.md`.
- **Nunca sai em resposta.** Mensagens de erro de serviços externos passam por `scrubSecret`, que troca o segredo por `[omitido]` (`security/secrets.ts`; uso em `modules/ai/routes.ts` e `integrations/anthropic.ts`). A criação do token de API mostra o token uma única vez; o banco guarda só o hash (`modules/api-tokens/routes.ts`, `security/tokens.ts`).
- **Logs:** o logger (pino) censura `authorization`, `cookie`, `set-cookie` e campos `password`, `secret` e `token` aninhados um nível (`apps/api/src/app.ts`, opção `redact`). Atenção: a redação é por caminho; um segredo colocado em outro campo de log não seria censurado, e o conteúdo de descrições de transações não passa por redação.
- **Auditoria:** `redact` troca por `[omitido]` o valor de qualquer chave que case com senha, segredo, token, hash, ciphertext, authorization, api key ou cookie, em `before`, `after` e `metadata` (`apps/api/src/audit/audit.ts`).
- **Limites:** a chave mestra fica em variável de ambiente da instalação; quem lê o ambiente do processo lê a chave. Não há integração com cofre externo (HSM/KMS).

## 6. Trilha de auditoria encadeada

- Tabela `audit_log` somente de inserção: `UPDATE`, `DELETE` e `TRUNCATE` são barrados por gatilho (`0001_base.sql`, `audit_log_immutable`, `audit_log_no_change`, `audit_log_no_truncate`).
- Cada registro recebe, no banco, o número de sequência da cadeia (uma cadeia por empresa e uma da plataforma), o hash do registro anterior e o próprio hash SHA-256 (`audit_log_chain`, `audit_log_hash`). Uma inserção por vez por cadeia.
- Toda operação que altera estado grava `ctx.audit(...)` na mesma transação da alteração (`apps/api/src/http/route.ts`, `apps/api/src/audit/audit.ts`).
- **O que registra:** quem (tipo, id e rótulo do autor), quando, ação, entidade, resumo, valores antes e depois (sem segredos), metadados, `requestId` e IP (`audit_log.ip`). Inclui logins e falhas, criação e alteração de usuários e papéis, decisões de conciliação, integrações, exportações, expurgo de arquivos, troca de chave, exportação e eliminação de empresa.
- **Verificação:** `GET /api/v1/audit/verify` (permissão `audit.view`) e `cli audit:verify --tenant <slug> | --platform` recalculam a cadeia; o comando sai com código 2 se estiver quebrada (`apps/api/src/modules/audit/routes.ts`, `cli.ts`).
- **Limite:** a verificação não detecta a remoção do último registro da cadeia. Registre o `headHash` fora do banco (`docs/08-operacao-backup-recuperacao.md`). Quem tem o papel dono do banco consegue desabilitar os gatilhos, como o próprio `tenant:purge` faz.
- Efeito para a privacidade: a trilha é imutável por desenho. Nome, e-mail e IP de pessoas gravados nela não são editáveis pelo produto.

## 7. Retenção e eliminação

### Retenção dos arquivos originais

- A empresa configura `imports.originalFileRetentionDays` (30 a 3650 dias; vazio = guardar sem limite; `packages/core/src/settings/schema.ts`).
- O trabalhador verifica a cada hora e agenda, no máximo uma vez por dia por empresa, o trabalho `maintenance.purge_import_files` (`apps/api/src/jobs/maintenance.ts`; função `maintenance_retention_tenants()` em `0006_retention.sql`). O trabalho apaga `import_files` de lotes processados há mais dias que a retenção, marca `import_batches.file_purged_at` e audita `import.files_purged` (`apps/api/src/modules/imports/retention.ts`).
- Ficam: lote, hash do arquivo, estatísticas, as transações e os lançamentos importados (registros de origem não são alterados nem apagados por este trabalho). A retenção atinge o arquivo bruto, **não** as descrições e contrapartes já gravadas nas tabelas de origem.
- Só roda onde há trabalhador ativo. Backups anteriores ainda contêm os arquivos.

### Exportação para portabilidade: `tenant:export`

```bash
node apps/api/dist/cli.js tenant:export --tenant <slug> --out <arquivo.ndjson> [--include-files]
```

- Pré-condição: `MIGRATION_DATABASE_URL` (papel dono). Não sobrescreve arquivo existente; cria com permissão 0600.
- Exporta todas as tabelas da empresa, descobertas pelo catálogo, em NDJSON, em uma fotografia consistente. **Exclui** `sessions` e colunas com hash de senha, texto cifrado, hash de token ou valor de segredo. `--include-files` inclui os arquivos originais em base64.
- Audita `tenant.data_exported`. Código em `apps/api/src/ops/tenant-export.ts`.
- Risco: o arquivo gerado contém dados pessoais e financeiros sem cifra. Proteja o destino e apague depois do uso.

### Eliminação definitiva: `tenant:purge`

```bash
node apps/api/dist/cli.js tenant:purge --tenant <slug> --confirm <slug>
```

- Pré-condições: papel dono (`MIGRATION_DATABASE_URL`); a empresa deve estar **arquivada**; `--confirm` repete o slug. Exporte e faça backup antes: é irreversível.
- Apaga em uma transação todas as linhas de todas as tabelas com `tenant_id` e a própria empresa, inclusive registros de origem e a trilha de auditoria da empresa. Desabilita os gatilhos de proteção apenas dentro da transação, reabilita antes do `COMMIT` e confere que nada restou; se restar algo, desfaz tudo (`apps/api/src/ops/tenant-purge.ts`).
- Grava `platform.tenant_purged` na trilha da plataforma, só com o identificador e contagens.

Ressalvas que precisam ser conhecidas antes de usar:

1. **A eliminação não apaga todos os rastros da empresa.** Registros da trilha da plataforma (cadeia com `tenant_id` nulo) que citam nome, slug e CNPJ da empresa, por exemplo `platform.tenant_created` e as alterações da empresa (`before`/`after` incluem o cadastro), permanecem (`apps/api/src/modules/platform/routes.ts`, `modules/tenancy/provisioning.ts`).
2. **A eliminação trava as gravações de todas as empresas.** Desabilitar gatilhos exige travar as tabelas até o fim da transação; gravações de qualquer empresa nessas tabelas esperam. Há `lock_timeout` de 30 s: se não conseguir as travas, a eliminação desiste sem alterar nada. Execute em janela de baixo uso.
3. **Backups e exportações já feitos continuam com os dados.** Descarte-os conforme a política da instalação.

### Troca da chave mestra: `secrets:rotate`

```bash
NEW_SECRETS_MASTER_KEY=<base64 de 32 bytes> NEW_SECRETS_KEY_VERSION=<1..255> node apps/api/dist/cli.js secrets:rotate
```

- Pré-condições: `MIGRATION_DATABASE_URL`, `SECRETS_MASTER_KEY` com a chave atual, backup recente.
- Uma transação; cancela tudo se algum segredo não decifrar; audita por empresa e na plataforma.
- **Depois da troca, a API e o trabalhador precisam reiniciar com `SECRETS_MASTER_KEY` e `SECRETS_KEY_VERSION` novos.** Enquanto rodarem com a chave antiga, não conseguem decifrar os segredos e as integrações falham. Código em `apps/api/src/ops/secrets-rotate.ts`.

## 8. Direitos do titular (LGPD, art. 18)

O produto não tem fluxo de atendimento a titulares. Quem responde ao titular é a empresa controladora, usando as funções abaixo.

| Direito | O que o produto oferece hoje | O que é manual |
|---|---|---|
| Confirmação e acesso | Consulta de usuários (`GET /users`), da trilha (`GET /audit`) e exportação de itens (`POST /exports/items`, permissão `exports.create`). Exportação completa da empresa por `tenant:export`. | Localizar os dados de uma pessoa específica nas descrições e contrapartes: não há busca por titular. Montar a resposta. |
| Correção | Alterar nome, papel e situação de usuário (`PATCH /users/:id`). | Dados em registros de origem (`bank_transactions`, `ledger_entries`) **não são alterados** por regra do produto; a correção é feita na fonte e reimportada. A trilha não é editável. |
| Eliminação | Desativar usuário (`PATCH /users/:id`); expurgo de arquivos por retenção; `tenant:purge` para a empresa inteira. | Não há exclusão de um usuário nem de um titular isolado: usuários são desativados, não removidos, e registros de origem e a trilha são imutáveis. Eliminação pontual exige análise caso a caso com o operador do banco, fora do produto. |
| Portabilidade | `tenant:export` em NDJSON; exportações CSV/XLSX de itens e resumos. | Formato de entrega ao titular. |
| Informação sobre compartilhamento | Lista de integrações e módulos habilitados por empresa; seção 3 deste documento. | Aviso de privacidade da empresa. |
| Revogação de consentimento | Não há registro de consentimento (ver seção 10). | Todo o processo. |

Bases legais e prazos de resposta são decisão jurídica da controladora.

## 9. Segurança das integrações

- **Bloqueio de endereços privados (SSRF).** `safeFetch` só aceita HTTPS (HTTP somente com `ALLOW_PRIVATE_INTEGRATION_HOSTS` em desenvolvimento), resolve o DNS e recusa destinos em faixas privadas, loopback, link-local, multicast e reservadas, IPv4 e IPv6, inclusive IPv4 mapeado. A conexão usa o endereço já conferido (contra DNS rebinding), não segue redirecionamento, tem tempo limite e limite de tamanho da resposta. Endereços de metadados de nuvem são recusados sempre, mesmo com a liberação (`apps/api/src/integrations/http.ts`).
- **Assinatura de webhooks.** Cabeçalho `x-concilia-signature: sha256=<HMAC-SHA256(segredo, timestamp.corpo)>`, com `x-concilia-timestamp`, `x-concilia-event` e `x-concilia-delivery`. O receptor valida a assinatura; o Concilia não impõe janela de validade do timestamp, e rejeitar entregas antigas é recomendação ao receptor (`apps/api/src/integrations/webhook.ts`; contrato em `docs/04-api-e-conectores.md`, seção 7). O segredo do webhook fica no cofre.
- **Tokens de API.** Prefixo `ck_`, 256 bits de aleatoriedade; só o SHA-256 e o prefixo ficam no banco; escopos, validade e revogação (`api_tokens`; `apps/api/src/security/tokens.ts`, `modules/api-tokens/routes.ts`). Exibidos uma única vez, na criação.
- **Verificação honesta.** A integração só fica `verified` após chamada real bem-sucedida (`docs/04-api-e-conectores.md`, seção 9); falha do provedor remove a situação `verified`.
- **Planilhas.** Fórmulas não são avaliadas na leitura; na exportação, células iniciadas por `=`, `+`, `-` ou `@` são neutralizadas (`docs/02-arquitetura.md`, seção 4).

## 10. O que não existe

Para evitar falsa expectativa, o produto **não** oferece hoje:

- **Segundo fator de autenticação** (TOTP, SMS, chave de segurança).
- **Login único** (SSO, SAML, OIDC) nem diretório externo.
- **Cifra em repouso gerida pela aplicação**, além dos segredos de integração. Descrições, valores, nomes, arquivos importados e a trilha ficam em texto no banco. A proteção do disco, do banco e dos backups (cifra de volume, cifra do `pg_dump`) depende da infraestrutura. O `ops/backup.sh` não cifra o dump.
- **Varredura de malware** nos arquivos enviados. Há validação de formato, limite de tamanho (`MAX_UPLOAD_MB`) e de linhas (`MAX_IMPORT_ROWS`), e as fórmulas não são avaliadas, mas o conteúdo não passa por antivírus.
- **Registro de consentimento** nem gestão de bases legais.
- **Busca ou eliminação por titular** (ver seção 8).
- **Cofre externo de chaves** (KMS/HSM) e **registro externo** do `headHash` da trilha.
- **Expurgo da trilha de auditoria** nem de `notification_deliveries`: não há política de retenção para elas fora da eliminação da empresa.
- **Conexão bancária.** O produto importa arquivos e lê APIs configuradas; não acessa contas.

## 11. Responsabilidades de quem opera

Pontos que dependem da instalação e não do código: HTTPS na frente da API e `COOKIE_SECURE` ligado, `TRUST_PROXY` correto (o IP gravado vem de `req.ip`), segregação do papel dono do banco, proteção e rotação de `SECRETS_MASTER_KEY` e `SESSION_SECRET`, cifra de disco e de backup, política de retenção de backups, registro das operações de exportação e eliminação, e o registro das atividades de tratamento exigido pela LGPD.
