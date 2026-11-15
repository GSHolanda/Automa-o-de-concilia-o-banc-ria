# 02 — Arquitetura e decisões técnicas

## 1. Visão geral

```
                  ┌──────────────────────────────────────────────────┐
  Navegador ────► │  apps/web  (React + Vite, pt-BR, responsivo)      │
                  └───────────────────────┬──────────────────────────┘
                                          │ HTTPS  /api/v1  (cookie de sessão + CSRF)
  Sistema financeiro ── token de API ───► │
                  ┌───────────────────────▼──────────────────────────┐
                  │  apps/api  (Node.js 22 + Fastify)                 │
                  │                                                   │
                  │  http/        rotas, validação, permissão, erro   │
                  │  modules/     casos de uso por contexto           │
                  │  jobs/        fila e trabalhadores                │
                  │  integrations/ conectores versionados, cofre      │
                  │  observability/ logs, métricas, saúde             │
                  └──────────┬───────────────────────┬───────────────┘
                             │ usa                   │ SQL (papel concilia_app, RLS)
                  ┌──────────▼──────────┐  ┌─────────▼────────────────┐
                  │  packages/core      │  │  PostgreSQL 16            │
                  │  domínio puro:      │  │  tenant_id + RLS          │
                  │  normalização,      │  │  auditoria encadeada      │
                  │  leitores, motor de │  │  fila de trabalhos        │
                  │  conciliação        │  │  arquivos originais       │
                  └─────────────────────┘  └──────────────────────────┘
```

Quatro camadas com dependência em um só sentido:

| Camada | Local | Responsabilidade | Depende de |
|---|---|---|---|
| Domínio | `packages/core` | Regras de negócio puras: dinheiro, datas, texto, leitores de arquivo, classificação, deduplicação, motor de conciliação, catálogo de permissões, esquema de configurações, registro de módulos, contratos v1. Sem banco, sem HTTP. | nada |
| Aplicação e persistência | `apps/api/src/modules`, `apps/api/src/db` | Casos de uso, transações, repositórios SQL, contexto de empresa. | domínio |
| Integrações | `apps/api/src/integrations` | Conectores versionados, cofre de segredos, proteção contra SSRF. | domínio |
| Interface | `apps/web` | Telas, formulários, navegação. Fala apenas com a API. | contratos |

## 2. Pilha tecnológica

| Item | Escolha | Motivo |
|---|---|---|
| Linguagem | TypeScript (modo estrito) em todo o projeto | Um só idioma para domínio, API e interface; tipos compartilhados. |
| Execução | Node.js 22 LTS | Suporte de longo prazo, ecossistema maduro. |
| API | Fastify 5 | Estável, rápido, bem documentado, ecossistema oficial de plugins. |
| Validação | Zod 4 | Um esquema gera validação, tipos e JSON Schema para o OpenAPI. |
| Banco | PostgreSQL 16 | Row-Level Security, transações, `SKIP LOCKED` para fila, sem custo de licença. |
| Acesso a dados | `pg` com SQL explícito | RLS e transações ficam visíveis e auditáveis; sem camada mágica. |
| Fila | Tabela no PostgreSQL | Um componente a menos para operar; transacional com os dados. |
| Interface | React 19 + Vite + React Router + TanStack Query | Padrão de mercado, fácil contratação. |
| Planilhas | `exceljs` | Leitura e escrita de XLSX, mantido. |
| CSV | `csv-parse` | Estável, lida com aspas e delimitadores. |
| PDF | `pdfkit` | Gera PDF sem navegador no servidor. |
| Testes | Vitest (unitário e integração), Playwright (ponta a ponta) | Rápidos, mesma linguagem. |
| Empacotamento | pnpm workspaces, tsup (API), Vite (web) | Monorepo simples. |

Custos de infraestrutura mínimos: um processo Node e um PostgreSQL. Não exige Redis, broker de mensagens nem armazenamento de objetos no MVP.

## 3. Decisões de arquitetura (ADR)

### ADR-01 Isolamento por `tenant_id` com Row-Level Security

**Decisão.** Banco compartilhado, esquema compartilhado, `tenant_id` em toda entidade de negócio, políticas RLS em todas essas tabelas.

- A aplicação conecta com o papel `concilia_app`, que **não** é dono das tabelas, não é superusuário e não tem `BYPASSRLS`. A API verifica isso ao iniciar e recusa subir caso contrário.
- Cada requisição roda em uma transação que define `app.tenant_id` e `app.user_id` com `set_config(..., true)` (escopo da transação). As políticas comparam `tenant_id = app_tenant_id()`.
- Sem contexto definido, `app_tenant_id()` é nulo e nenhuma linha é visível.
- Chaves estrangeiras compostas `(tenant_id, id)` impedem que um registro de uma empresa referencie outro de outra empresa, mesmo por erro de aplicação.
- Operações anteriores ao contexto (login, busca de sessão, token de API, captura de trabalho da fila) usam funções `SECURITY DEFINER` de escopo estreito, de propriedade do papel dono.

**Alternativas descartadas.** Esquema por empresa (migrações e conexões multiplicam com o número de clientes); banco por empresa como único modo (custo operacional alto para clientes pequenos). O modo dedicado continua possível: ver ADR-02.

**Limite.** RLS protege contra erros da aplicação (filtro esquecido). Não protege contra quem controla o papel dono do banco.

### ADR-02 Dois modos de implantação, um código

`DEPLOYMENT_MODE=multi` (várias empresas na mesma instalação) ou `single` (uma empresa por instalação, banco próprio). No modo `single` a criação de uma segunda empresa é bloqueada e a área de operador da plataforma fica oculta. Não há ramificação de regra de negócio.

### ADR-03 Usuário pertence a uma única empresa

E-mail único na instalação; cada usuário pertence a exatamente uma empresa (operadores da plataforma não pertencem a nenhuma). Simplifica o isolamento e torna seguro o administrador redefinir senhas.

**Consequência.** A mesma pessoa em duas empresas precisa de dois e-mails. Vínculo de um usuário a várias empresas é evolução prevista (tabela de vínculos), registrada em limitações.

### ADR-04 Fila de trabalhos no PostgreSQL

Tabela `jobs` com captura por `FOR UPDATE SKIP LOCKED`, chave de idempotência única por empresa e tipo, tentativas com espera exponencial, estado final `dead`. O trabalhador roda no mesmo processo da API (`WORKER_ENABLED=true`) ou em processo separado (`pnpm worker`).

**Motivo.** Enfileirar na mesma transação que grava o lote evita trabalho órfão; um serviço a menos para instalar e monitorar. **Limite.** Vazão de dezenas de trabalhos por segundo, suficiente para o perfil de uso; substituível por broker dedicado atrás da mesma interface.

### ADR-05 Decisões financeiras são determinísticas

O motor de conciliação é uma função pura em `packages/core`: mesmas entradas e regras, mesma saída. A conciliação automática depende de **regras** (identificador, valor, data, unicidade), nunca de limiar de pontuação. A pontuação de confiança serve apenas para ordenar e explicar sugestões. Cada resultado registra o código da regra e a versão do motor.

### ADR-06 IA apenas como apoio opcional

Módulo opcional `ai.assist`, atrás da interface `AiAssistProvider`. Produz somente sugestões (categoria de transação, mapeamento de colunas), gravadas como sugestão com origem identificada e sujeitas a aceite humano. Nenhuma regra de conciliação consulta IA. Sem credencial configurada, o módulo permanece inativo; a heurística local de mapeamento de colunas é determinística e identificada como heurística, não como IA.

### ADR-07 Registros originais imutáveis

`bank_transactions` e `ledger_entries` guardam os dados de origem. Um gatilho no banco rejeita `UPDATE` nas colunas originais e qualquer `DELETE` pelo papel da aplicação. Decisões (conciliar, ignorar, classificar, desfazer) vivem em `matches` e `match_items`. A situação do item (`recon_status`) é estado derivado, não dado original.

### ADR-08 Trilha de auditoria encadeada

`audit_log` aceita apenas `INSERT`. Um gatilho calcula, por empresa, `hash = sha256(hash_anterior || conteúdo)` sob trava consultiva. `UPDATE` e `DELETE` são rejeitados por gatilho e o papel da aplicação não tem esses privilégios. Uma rotina de verificação recalcula a cadeia e aponta a primeira quebra.

### ADR-09 Sessões no servidor com cookie

Token opaco aleatório (256 bits) em cookie `HttpOnly`, `SameSite=Lax`, `Secure` em produção; o banco guarda apenas o SHA-256 do token. Expiração por inatividade e absoluta. Revogação imediata. Requisições que alteram estado exigem cabeçalho `X-CSRF-Token` derivado da sessão.

**Motivo.** Revogação imediata e listagem de sessões são requisitos; JWT sem estado não atende sem lista de revogação.

### ADR-10 Configuração da empresa fora do código

- **Por implantação:** variáveis de ambiente validadas na inicialização (`apps/api/src/config/env.ts`).
- **Por empresa:** tabelas de cadastro e o documento `tenant_settings.data`, validado por esquema Zod versionado em `packages/core`. Chaves novas recebem valor padrão ao ler; nunca há perda de configuração em atualização.
- **Modelos iniciais:** `config/templates/` (plano de contas, categorias, regras de classificação, papéis) aplicados no onboarding e depois editáveis pela empresa.

### ADR-11 Cofre de segredos

Segredos de integração são cifrados com AES-256-GCM. Chave mestra em `SECRETS_MASTER_KEY` (fora do banco). Dados autenticados adicionais incluem `tenant_id` e o identificador da integração, de modo que o texto cifrado não pode ser movido entre empresas. A API nunca devolve o segredo; devolve apenas se está configurado.

### ADR-12 Contratos versionados

- API pública sob `/api/v1`; a especificação OpenAPI é gerada dos mesmos esquemas que validam as requisições (`GET /api/v1/openapi.json`).
- Conectores implementam interfaces versionadas em `packages/core/src/contracts/v1`. Mudança incompatível cria `v2` ao lado de `v1`.

### ADR-13 Migrações somente para frente

Arquivos SQL numerados em `apps/api/migrations`. O executor registra nome e checksum em `schema_migrations`, aplica cada arquivo em transação e interrompe se um arquivo já aplicado tiver sido alterado. Reversão é feita por restauração de backup ou por nova migração corretiva.

## 4. Segurança

| Tema | Controle |
|---|---|
| Senhas | scrypt (N=2^17, r=8, p=1 em produção), sal aleatório por senha, comparação em tempo constante. |
| Força bruta | Limite de requisições por IP nas rotas de autenticação; bloqueio temporário da conta após falhas sucessivas. |
| Sessão | Ver ADR-09. Troca de senha encerra as demais sessões. |
| Autorização | Catálogo de permissões no domínio; cada rota declara a permissão; papéis por empresa. |
| Isolamento | Ver ADR-01. |
| Entrada | Validação Zod em corpo, parâmetros e consulta. Limite de tamanho e de linhas em arquivos. |
| Planilhas | Fórmulas não são avaliadas na leitura. Na exportação CSV/XLSX, células iniciadas por `=`, `+`, `-`, `@` são neutralizadas. |
| Saída HTTP para terceiros | Webhooks e conector REST resolvem o DNS e recusam endereços privados, de loopback e link-local (exceto se liberado em desenvolvimento). |
| Cabeçalhos | Helmet com CSP restritiva; sem CORS por padrão (mesma origem). |
| Segredos | Ver ADR-11. Logs com redação de campos sensíveis. |
| LGPD | Detalhado em `09-seguranca-lgpd.md`. |

## 5. Fluxos principais

### Importação

1. Envio do arquivo → cria `import_batches` (situação `uploaded`), grava o arquivo e o hash. Hash repetido para a mesma conta e origem → erro de duplicidade.
2. Pré-visualização: formato detectado, cabeçalhos, amostra, mapeamento sugerido.
3. Confirmação com perfil/mapeamento → enfileira `import.process` na mesma transação.
4. Trabalhador: lê, normaliza, classifica, calcula chave de deduplicação, insere com `ON CONFLICT DO NOTHING`, grava rejeições e estatísticas.

### Conciliação

1. Usuário solicita execução para conta e período → cria `reconciliation_runs` com cópia das regras vigentes e enfileira `reconciliation.run`.
2. Trabalhador carrega itens pendentes, executa o motor e grava, em uma transação: conciliações automáticas (itens passam a `reconciled`), sugestões e divergências.
3. Revisão humana: aceitar, rejeitar, conciliar manualmente, classificar, ignorar, desfazer. Conforme a configuração, a decisão fica `pending_approval` até segunda aprovação.

## 6. Módulos

| Chave | Tipo | Conteúdo |
|---|---|---|
| `core.reconciliation` | obrigatório | Importação, normalização, motor, revisão, painel, exportação. |
| `core.access` | obrigatório | Autenticação, usuários, papéis, sessões. |
| `core.audit` | obrigatório | Trilha de auditoria e verificação. |
| `approvals` | opcional | Aprovação em duas etapas. |
| `grouping` | opcional | Sugestões N:1 e 1:N. |
| `transfers` | opcional | Pareamento de transferências internas entre contas. |
| `api.inbound` | opcional | API de entrada de lançamentos por token. |
| `connector.rest` | opcional | Conector REST de leitura de lançamentos. |
| `notifications.webhook` | opcional | Notificações por webhook assinado. |
| `notifications.email` | opcional | Notificações por e-mail (SMTP). |
| `ai.assist` | opcional | Sugestões de classificação por provedor de IA. |

O registro de módulos fica em `packages/core/src/modules.ts`. A habilitação por empresa fica em `tenant_modules`, limitada pelo plano. Rotas de módulo opcional respondem 403 `module_disabled` quando o módulo está desligado.

## 7. Observabilidade

- **Logs:** JSON estruturado (pino), `requestId` em cada linha, redação de cabeçalhos de autenticação, cookies e campos de segredo.
- **Métricas:** `GET /metrics` em formato Prometheus (latência e contagem HTTP, trabalhos por tipo e resultado, profundidade da fila, importações, conciliações).
- **Saúde:** `GET /healthz` (processo vivo) e `GET /readyz` (banco acessível, migrações em dia).
- **Alertas:** regras de exemplo em `ops/alerts.yml`; trabalho em estado `dead` gera notificação interna aos administradores da empresa.

## 8. Estrutura do repositório

```
apps/
  api/            API, trabalhador, CLI, migrações, testes de integração
  web/            interface
packages/
  core/           domínio puro e contratos
config/templates/ modelos de configuração inicial
demo/             gerador de dados fictícios
e2e/              testes ponta a ponta
ops/              Dockerfile, compose, alertas, scripts de backup
docs/             documentação
```

## 9. Limitações conhecidas

Lista completa e atualizada em `11-limitacoes-riscos-dependencias.md`.
