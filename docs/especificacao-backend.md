# Especificação do backend (E5–E10)

Contrato de cada etapa: rotas, regras e testes. Convenções gerais em `CLAUDE.md`. Todas as rotas ficam sob `/api/v1`.
Permissões entre parênteses; `auth` = qualquer usuário autenticado da empresa.

## E5 — Acesso, sessões, auditoria, plataforma

Já existem: `config/env.ts`, `security/{password,tokens}.ts`, `http/{errors,route,auth}.ts`, `audit/audit.ts`, `deps.ts`,
`modules/tenancy/{entitlements,provisioning}.ts`, `modules/settings/service.ts`, `observability/metrics.ts`,
testes `test/api/auth.test.ts` e `test/helpers/app.ts`. Faltam:

- `src/app.ts` — `buildApp(config): Promise<FastifyInstance>`:
  logger pino com redação (`req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.secret`, `*.token`),
  `genReqId`, `trustProxy`; plugins cookie, helmet (CSP restritiva), rate-limit (`global: false`), multipart
  (`fileSize = config.maxUploadBytes`, 1 arquivo); `pg.Pool`; `assertSafeRuntimeRole` na subida; `createMetrics`;
  `dummyPasswordHash`; gancho `onResponse` alimentando `metrics.httpDuration` (rótulo `route` = padrão da rota);
  manipulador de erro: `AppError` → `{error:{code,message,details?,requestId}}`; `ZodError` → 400 `validation_error`
  com `details: [{path,message}]`; `fromDatabaseError`; demais → 500 `internal_error` (registrar em log, não vazar);
  404 em JSON (`not_found`); `GET /healthz` `{status:'ok'}`; `GET /readyz` (ping no banco e versão do esquema igual à
  esperada → `{status,database,schema}`; 503 se não); `GET /metrics` (exige `Bearer METRICS_TOKEN` se definido);
  `GET /api/v1/openapi.json` (pública, `buildOpenApi`); arquivos estáticos de `config.webDistDir` com fallback SPA
  para GET fora de `/api`; `onClose` fecha o pool.
- `src/routes.ts` — lista central dos `routes` de cada módulo.
- `src/main.ts` (sobe o servidor; encerramento gracioso), `src/worker-main.ts` (por ora só avisa que a fila chega na E7),
  `src/cli.ts`: `db:migrate`, `platform:create-admin`, `tenant:create`, `audit:verify --tenant <slug>`.

### Autenticação — `modules/auth/routes.ts`
- `POST /auth/login` (pública, limite 10/min por IP) `{email,password}`:
  `auth_find_user`; inexistente → verificar contra `deps.dummyPasswordHash` e responder 401 `invalid_credentials`
  ("E-mail ou senha inválidos."), resposta idêntica à de senha errada; conta bloqueada (`locked_until > now`): senha
  correta → 423 `account_locked`, errada → 401; senha errada → `auth_register_login_failure` + auditoria
  `auth.login_failed`; `status != active` → 403 `account_disabled`; empresa `archived` → 403 `tenant_unavailable`;
  sucesso → `auth_register_login_success`, sessão (token aleatório, grava só SHA-256; `expires_at` =
  agora + `sessionAbsoluteHours`; `idle_minutes` = `settings.security.sessionIdleMinutes`, 60 para plataforma),
  cookie `concilia_sid` (HttpOnly, SameSite=Lax, Secure conforme config, Path=/), auditoria `auth.login`,
  corpo igual ao de `/auth/me`. Contar em `metrics.loginAttempts`.
- `GET /auth/me` (auth; permitido com troca de senha pendente; também para plataforma — use `auth: 'session'` não
  serve à plataforma: registre a rota de modo que ambos funcionem, ex. tratando `tenantId` nulo):
  `{user:{id,name,email,mustChangePassword}, tenant:{id,slug,tradeName,legalName,status,onboarding}|null,
  role:{key,name}|null, permissions[], modules[], license:{planCode,planName,status,validUntil,readOnly,
  readOnlyReason,limits}|null, branding, csrfToken, isPlatformAdmin, productName, deploymentMode}`.
- `POST /auth/logout` → 204, revoga, auditoria `auth.logout`, limpa cookie.
- `POST /auth/password` `{currentPassword,newPassword}` → 204; senha atual errada → 400 `invalid_password`; política
  `passwordProblem` com `settings.security.passwordMinLength`; revoga as outras sessões; auditoria `auth.password_changed`.
- `GET /auth/sessions` → `{items:[{id,createdAt,lastSeenAt,expiresAt,ip,userAgent,current}]}`;
  `DELETE /auth/sessions/:id` → 204 (só do próprio usuário; 404 se não for).
- Rotas de autenticação não são bloqueadas por licença inativa (`write: false`).

### Usuários e papéis — `modules/access/routes.ts` (users.manage)
- `GET /users`; `POST /users` `{name,email,roleId,password?}` → 201 `{id,temporaryPassword?}` (sem senha: gera
  temporária e obriga troca); respeitar `limits.maxUsers` (403 `limit_reached`); e-mail repetido → 409.
- `PATCH /users/:id` `{name?,roleId?,status?}`; desativar revoga sessões; não pode sobrar a empresa sem ao menos um
  usuário ativo com `users.manage` (409 `last_admin`).
- `POST /users/:id/reset-password` → `{temporaryPassword}`, revoga sessões; `POST /users/:id/revoke-sessions` → 204.
- `GET /roles` (com contagem de usuários); `POST /roles` `{key,name,description?,permissions[]}` (usa
  `sanitizePermissions`); `PATCH /roles/:id` e `DELETE /roles/:id` só para papéis não-sistema (403 `system_role`);
  papel em uso não é apagado (409).
- Auditoria em toda escrita, com antes/depois.

### Auditoria — `modules/audit/routes.ts` (audit.view)
- `GET /audit?action=&entityType=&entityId=&actorId=&from=&to=&limit=&cursor=` (limite ≤ 200, mais recentes primeiro).
- `GET /audit/verify` → `{intact,checked,brokenSeq,headSeq,headHash}` via `audit_verify_chain`.

### Plataforma — `modules/platform/routes.ts` (`auth: 'platform'`)
- `GET /platform/tenants` (com plano, situação da licença, nº de usuários); `POST /platform/tenants`
  `{slug,legalName,tradeName,taxId?,planCode,admin:{name,email}}` → 201 `{tenantId,slug,temporaryPassword}`
  (`provisionTenant`); `GET /platform/tenants/:id`; `PATCH /platform/tenants/:id` `{legalName?,tradeName?,taxId?,status?}`;
  `PUT /platform/tenants/:id/license` `{planCode,status,validUntil?,limitsOverride?,externalRef?,notes?}`;
  `GET /platform/plans`; `GET /platform/audit`. Auditoria de plataforma (`tenantId: null`) em toda escrita.

Pronto quando: `pnpm --filter @concilia/api test` e `pnpm -r typecheck` passam.

## E6 — Configuração por empresa

- `GET /settings` (settings.view) → `{settings,version}`; `PUT /settings` (settings.manage) `{patch,version?}` →
  `updateTenantSettings`; ativar `approvals.enabled` exige módulo `approvals` (403 `module_disabled`).
- `GET /company` (auth), `PATCH /company` (settings.manage) `{legalName?,tradeName?,taxId?}`.
- CRUD (leitura: auth; escrita: settings.manage; exclusão em uso → 409):
  `/org-nodes?kind=`, `/chart-accounts`, `/categories`, `/bank-accounts` (respeita `limits.maxBankAccounts`),
  `/classification-rules`, `/import-profiles` (`config` validado por `importProfileConfigSchema`), `/report-templates`.
  Um utilitário genérico de CRUD evita repetição.
- `GET /modules` (auth) → catálogo com `{key,name,description,required,inPlan,enabled,externalDependency}`;
  `PUT /modules/:key` `{enabled}` (modules.manage) → `canEnableModule`, senão 403 `module_not_in_plan`.
- `GET /license` (auth) → `Entitlements`.
- Onboarding: `GET /onboarding` → `{status,steps:[{key,title,required,done}],canComplete}`; etapas `company`,
  `branding`, `bank_accounts`, `structure`, `chart`, `import_profile`, `rules`, `users`;
  `PUT /onboarding/steps/:key` `{done}`; `POST /onboarding/apply-template` `{template}` aplica
  `config/templates/<template>.json` (plano de contas e categorias; idempotente por código);
  `POST /onboarding/complete` (exige `company` e ao menos uma conta bancária) → empresa `active`.
  Estado em `tenants.onboarding`.
- Testes: CRUD, validação, CA-24, CA-25 (licença suspensa: escrita 403 `license_inactive`, leitura 200),
  isolamento de cada recurso entre duas empresas (404 e listas sem vazamento).

## E7 — Fila e importação

Fila (`src/jobs/`):
- `enqueue(db,{tenantId,type,payload,idempotencyKey,maxAttempts?,createdBy?})` → `{job,created}`
  (`ON CONFLICT (tenant_id,type,idempotency_key) DO NOTHING`; em conflito devolve o existente).
- Trabalhador: `jobs_release_stale`, `jobs_claim`; cada trabalho roda em `withContext({tenantId})` próprio; sucesso →
  `succeeded` + `result`; falha → se `attempts < max_attempts`, volta a `queued` com `run_at` = agora + min(2^tentativas × 5 s,
  10 min) e `last_error`; senão `dead`, auditoria `job.dead` e aviso interno a quem tem `settings.manage`.
  A atualização de situação é feita em transação separada da do manipulador. `runPendingJobs(deps)` drena a fila
  de forma síncrona para os testes. Manipuladores são idempotentes.
- `GET /jobs?status=&type=` (imports.view); `POST /jobs/:id/retry` (imports.create; só `dead`).

Importação (`src/modules/imports/`):
- `POST /imports` (imports.create, multipart): campos `sourceKind` (bank|ledger), `bankAccountId` (obrigatório para
  bank), `profileId?`, arquivo. Formato por conteúdo e extensão (OFX contém `<OFX>`; XLSX começa com `PK`; senão CSV).
  Grava `import_batches` (`uploaded`) + `import_files` + SHA-256. Mesmo arquivo → 409 `duplicate_file` com o id do
  lote existente. Vazio ou acima do limite → 400/413. Responde 201 `{id,fileFormat,preview}`.
  Pré-visualização OFX: `{account,period,transactionCount,sample,accountMatches}`; CSV/XLSX:
  `{sheetNames?,headerRow,headers,sampleRows,suggestion}` (`suggestMapping`).
- `GET /imports/:id/preview?sheetName=`; `POST /imports/:id/confirm`
  `{profileId?|config?,allowAccountMismatch?,saveProfileAs?}` → copia a configuração para o lote, `queued`,
  enfileira `import.process` (chave = id do lote), auditoria → 202 `{jobId}`; `POST /imports/:id/cancel` (só `uploaded`).
- `GET /imports`, `GET /imports/:id` (lote, estatísticas, trabalho), `GET /imports/:id/rejections`,
  `GET /imports/:id/file` (original; audita), `POST /imports/:id/reprocess`.
- Manipulador `import.process`:
  - OFX: `decodeOfxBuffer` + `parseOfx`; conta do arquivo × conta selecionada (dígitos de ACCTID e de
    `account_number`: uma termina com a outra); divergência sem `allowAccountMismatch` → lote `failed` com mensagem.
  - CSV/XLSX: `decodeText`/`detectDelimiter`/`parseCsv` ou `readXlsx` → `mapTabular`. `ImportConfigError` → lote `failed`.
  - Limite `config.maxImportRows` e `limits.maxMonthlyTransactions`.
  - Para cada registro: `description_norm`, `identifiers` (documento, referência e `extractReferences`), `classify`
    com as regras da empresa.
  - Extrato: `computeDedupKeys(bankAccountId, …)`, `INSERT … ON CONFLICT DO NOTHING`. Linha nova cuja
    `similarity_key` já existe em outro lote → `duplicate_suspect`, `recon_status='divergent'` e um `matches`
    `ignored`/`suggested` com `divergence='duplicate'` para decisão humana.
  - Lançamentos: conta por `batch.bank_account_id` ou por `bankAccountRef` (compara com `external_ref`, nome e número);
    `external_id` existente com `content_hash` igual → duplicado; diferente → `import_rejections` `conflict`, sem
    sobrescrever.
  - Rejeições por linha em `import_rejections`. Estatísticas `{totalRows,imported,duplicates,rejected,conflicts,
    skipped,duplicateSuspects,periodStart,periodEnd}`. Situação final `completed` | `completed_with_errors` | `failed`.
    Falha de conteúdo não é repetida (trabalho conclui; o lote fica `failed`). Auditoria `import.processed`.
- Testes: CA-01 a CA-05, CA-22, arquivo com período sobreposto, linhas idênticas legítimas, isolamento.

## E8 — Conciliação e revisão

- `POST /reconciliation/runs` (reconciliation.run) `{bankAccountId,periodStart,periodEnd}` → grava a execução com
  `rules_snapshot` (regras da empresa; `grouping`/`transfers` desligados se o módulo não estiver ativo), enfileira
  `reconciliation.run` → 202 `{runId,jobId}`. `GET /reconciliation/runs`, `GET /reconciliation/runs/:id`.
- Manipulador: trava consultiva por empresa+conta; sugestões `suggested` de origem `engine` da conta → `superseded`
  (itens `divergent` voltam a `pending`); carrega extrato pendente da conta no período, lançamentos pendentes da conta
  (ou sem conta) no período ± max(`dateToleranceDays`,`identifierMaxDateDiffDays`), extrato pendente de outras contas
  classificado como transferência, e `pair_key` rejeitados; `reconcile()`; grava: `auto` → `confirmed`,
  `auto_confirmed`, itens `active` e `reconciled`; `suggest` → `suggested`; divergência → itens `divergent`.
  Conflito no índice único de item ativo → descarta aquele resultado. Auditoria `reconciliation.run_completed`.
- `GET /reconciliation/items?side=&bankAccountId=&status=&kind=&hasSuggestion=&dateFrom=&dateTo=&amountMin=&amountMax=&q=`
  (reconciliation.view) — `q` busca em descrição, documento, identificador e referência.
  `GET /reconciliation/items/:side/:id` → item, linha bruta e histórico de decisões.
- `GET /reconciliation/matches?status=&type=&bankAccountId=&divergent=&minConfidence=` com os itens dos dois lados;
  `GET /reconciliation/matches/:id`.
- Decisões (reconciliation.review, salvo indicação):
  - `POST …/matches/:id/accept` `{note?}`: `suggested` → `pending_approval` se `approvalRequired` (módulo `approvals`
    ativo) senão `confirmed`. Itens ficam `active`; violação do índice único → 409 `already_reconciled`. Sugestões
    concorrentes dos mesmos itens → `superseded`. `recon_status='reconciled'` só ao confirmar.
  - `POST …/matches/:id/reject` `{reason}` → `rejected`.
  - `POST …/matches/:id/approve` `{note?}` (reconciliation.approve): `pending_approval` → `confirmed`; com `fourEyes`,
    quem propôs não aprova (403 `four_eyes`). `POST …/matches/:id/refuse` `{reason}` → `rejected`, libera itens.
  - `POST …/matches/:id/undo` `{reason}` (reconciliation.undo): `confirmed` → `undone`, itens voltam a `pending`.
  - `POST /reconciliation/matches/manual` `{bankTransactionIds[],ledgerEntryIds[],note?}`: ao menos um de cada lado,
    todos pendentes e livres, mesmo sinal; diferença ≠ 0 exige `note`.
  - `POST /reconciliation/items/ignore` `{side,id,reason}`; `POST /reconciliation/items/classify`
    `{bankTransactionId,categoryId,note?}`.
  - `POST /reconciliation/matches/bulk-accept` `{ids[]}`: só sugestões não ambíguas e sem divergência; resultado por id.
- `GET /dashboard?bankAccountId=&dateFrom=&dateTo=` (dashboard.view) → contagem e soma por situação (extrato e
  lançamentos), sugestões abertas, aprovações pendentes, por conta, última importação e última execução, taxa de
  conciliação automática.
- Pedido de aprovação gera aviso interno a quem tem `reconciliation.approve`.
- Toda decisão grava auditoria. Testes: CA-06 a CA-10, CA-12, CA-14, CA-21, duas aceitações concorrentes
  (uma responde 409), isolamento.

## E9 — Exportação (exports.create)

- `POST /exports/items` `{format: csv|xlsx|pdf, filters, templateId?}` → arquivo. CSV: UTF-8 com BOM, `;`, CRLF,
  valores com `formatDecimalBR`. Em CSV e XLSX, texto iniciado por `=`, `+`, `-`, `@`, tabulação ou CR recebe `'` à frente.
  XLSX: colunas tipadas (data, número). PDF: A4 paisagem, cabeçalho (empresa, título, período, gerado em/por), totais
  e numeração de páginas.
- `POST /exports/summary` `{format: pdf|xlsx, bankAccountId, dateFrom, dateTo, templateId?}` → resumo por situação,
  pendentes, divergentes e conciliações por regra.
- `POST /exports/pending-entries` `{format: csv|xlsx, …}` → classificações confirmadas sem lançamento (a lançar no ERP).
- Limite de 50.000 linhas (422). Auditoria `export.created` com filtros, formato e quantidade.
- Testes: CA-20 (gerar, reabrir e conferir conteúdo filtrado), neutralização de fórmulas, isolamento.

## E10 — Integrações

- Cofre `src/security/secrets.ts`: AES-256-GCM, formato `versão(1)|iv(12)|tag(16)|cifra`, AAD `tenantId:integrationId`.
- `src/integrations/http.ts` `safeFetch`: só HTTPS (HTTP apenas com `allowPrivateIntegrationHosts`), resolve DNS e
  recusa endereços privados, loopback, link-local e de metadados; sem redirecionamento; tempo limite de 10 s; resposta
  até 5 MB.
- `/integrations` (integrations.manage): tipos `webhook {url}`, `smtp {host,port,secure,user,from}`,
  `rest_ledger {baseUrl,path,authType,headerName?,itemsPath?,fieldMap,bankAccountId?}`, `ai_provider {provider,model}`.
  Campo `secret` só de escrita; respostas trazem `hasSecret`. `POST /integrations/:id/test` faz chamada real e grava
  `verified` ou `error` + `last_error`. Cada tipo exige o módulo correspondente.
- `/api-tokens` (integrations.manage, módulo `api.inbound`): cria (token exibido uma vez), lista (só prefixo), revoga.
- `POST /integrations/ledger/entries` (token de API, escopo `ledger:write`, módulo `api.inbound`), cabeçalho
  `Idempotency-Key` obrigatório, até 1.000 lançamentos → lote de origem `api` + `import.process` → 202 `{batchId}`.
  Mesma chave → mesmo lote. `GET /integrations/ledger/batches/:id`.
- Notificações: eventos `import.completed`, `import.failed`, `reconciliation.completed`, `approval.requested`,
  `job.dead`. `/notification-rules` (settings.manage); `GET /notifications`, `POST /notifications/:id/read`;
  `GET /notification-deliveries`. Webhook: trabalho `notification.deliver`, POST com `X-Concilia-Event`,
  `X-Concilia-Timestamp`, `X-Concilia-Signature: sha256=HMAC(segredo, timestamp.corpo)`; grava `sent` só com 2xx.
  E-mail por SMTP (nodemailer).
- Conector REST: contrato `LedgerConnectorV1` em `packages/core/src/contracts/v1`; `POST /integrations/:id/pull`
  `{dateFrom,dateTo}` → trabalho `connector.pull` → lote de origem `connector`.
- IA (módulo `ai.assist`): interface `AiAssistProviderV1.suggestCategories`; adaptador Anthropic;
  `POST /ai/suggest-categories` `{bankTransactionIds}` grava sugestões de classificação identificadas como IA
  (migração nova acrescenta origem `ai`), nunca confirma. Envia só descrição normalizada, sinal e tipo.
  Sem integração verificada → 409 `integration_not_configured`.
- Testes: CA-23, CA-27, webhook contra servidor HTTP local de teste (identificado como tal) com conferência da
  assinatura, idempotência e revogação da API de entrada, `safeFetch` recusando endereço privado.

## Referência do que já existe (use, não reescreva)
- Fila (`apps/api/src/jobs/`): `enqueue(db,{tenantId,type,payload,idempotencyKey,maxAttempts?,createdBy?}) → {job,created}`;
  `registerJobHandler(type, handler)` em `jobs/handlers.ts`, com
  `JobHandler = { run({db,job,tenantId,deps,audit}), onDead?(db,job,error), onRetry?(db,job) }`;
  `runPendingJobs(deps) → {processed,succeeded,retried,dead}`; `app.deps` dá acesso às dependências nos testes.
- Paginação por cursor: `src/http/cursor.ts`. CRUD genérico: `src/modules/registry/crud.ts`.
- Utilitários de teste (`test/helpers/imports.ts`): `createBankAccount(tenantId, {...}) → {id,name,accountNumber}`,
  `createImportProfile(tenantId, {name?,sourceKind,fileFormat,config})`, `buildOfx({accountId, transactions:[{date,amount,memo,
  type?,fitId?,name?,checkNum?}]})`, `buildCsv(rows,{delimiter?,encoding?})`, `buildXlsx(rows)`,
  `uploadImport(client,{sourceKind,bankAccountId?,profileId?,fileName,content})`,
  `importFile(app, client, upload, confirmBody?) → {batchId,jobId}`, `drainJobs(app)`, `bankTransactionsOf(batchId)`,
  `ledgerEntriesOf(batchId)`.
- Possível duplicidade na importação já gera `matches` `ignored`/`suggested` com `divergence='duplicate'`.
- E6 pronta: `/settings`, `/company`, cadastros, `/modules`, `/license`, `/onboarding`.
