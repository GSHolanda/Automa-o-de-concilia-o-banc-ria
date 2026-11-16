# API e conectores

Referência da API HTTP do Concilia e dos conectores de integração. Os dados de exemplo são fictícios.

A lista de rotas desta página foi gerada a partir do registro real das rotas (`apps/api/src/routes.ts`). Quando uma rota mudar, a fonte de verdade é a especificação OpenAPI servida pela própria API (seção 6).

## 1. Convenções

- **Prefixo:** todas as rotas de negócio ficam em `/api/v1`. Exemplo: `GET /api/v1/bank-accounts`.
- **Infraestrutura fora do prefixo:** `GET /healthz` (processo no ar), `GET /readyz` (banco e esquema), `GET /metrics` (Prometheus; aceita `Bearer` quando `METRICS_TOKEN` está definido).
- **Erros:** toda resposta de erro tem o formato abaixo. `details` aparece só quando há informação extra. `requestId` identifica a requisição nos registros.

  ```json
  {
    "error": {
      "code": "idempotency_key_reused",
      "message": "Esta Idempotency-Key já foi usada com outro conteúdo.",
      "details": { "batchId": "7f0c2a1e-0000-4000-8000-000000000001" },
      "requestId": "req-abc123"
    }
  }
  ```

- **Listas e paginação por cursor:** listas respondem `{ "items": [...], "nextCursor": "..." }`. O campo `nextCursor` aparece só quando há mais itens. Parâmetros comuns: `limit` (1 a 200; padrão 50) e `cursor` (valor opaco devolvido pela API). Cursor inválido responde 400 com código `invalid_cursor`. Não monte cursores à mão.
- **Criação:** responde 201 com o recurso criado. Trabalhos assíncronos respondem 202.
- **Datas:** data civil no formato `AAAA-MM-DD` (por exemplo, `2026-11-14`). Instantes em ISO 8601 com fuso (por exemplo, `2026-11-14T12:00:00.000Z`).
- **Valores monetários:** inteiros em centavos (`amountCents`, `-15000` é R$ 150,00 de saída). Entrada é positiva e saída é negativa. Nunca envie valores decimais em campos `*Cents`.
- **Nomes de campos:** JSON em `camelCase`.
- **Idioma:** mensagens de erro e textos de resposta em português do Brasil.
- **Limite de taxa:** algumas rotas (login, por exemplo) têm limite por IP. Ao exceder, a resposta é 429 com código `rate_limited`.

## 2. Autenticação

A API aceita dois mecanismos. Cada rota declara qual deles aceita (coluna **Auth** da tabela da seção 4).

### 2.1 Sessão (usuários da empresa e operadores da plataforma)

1. Faça login com `POST /api/v1/auth/login`, com corpo `{ "email": "...", "password": "..." }`.
2. A resposta define o cookie `concilia_sid`, com `HttpOnly` e `SameSite=Lax`. O atributo `Secure` depende de `COOKIE_SECURE`.
3. A resposta do login também traz `csrfToken`, que é calculado a partir da sessão.
4. Em toda requisição que não seja `GET`, envie o cookie e o cabeçalho `X-CSRF-Token` com esse valor. Sem o cabeçalho correto, a API responde 403 com código `csrf_invalid`.

Sessões expiram por inatividade e por tempo absoluto. Expiração responde 401 com código `session_expired`. Usuário com senha temporária recebe 403 com código `password_change_required` em todas as rotas, exceto as que permitem a troca.

Exemplo de login e de uma escrita:

```bash
BASE=https://concilia.exemplo.test

curl -sS -c cookies.txt -X POST "$BASE/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"analista@demo.exemplo.test","password":"<senha>"}'

CSRF=<valor de csrfToken devolvido pelo login>

curl -sS -b cookies.txt -X POST "$BASE/api/v1/reconciliation/matches/<id>/accept" \
  -H "X-CSRF-Token: $CSRF"
```

### 2.2 Token de API (integrações)

Tokens de API têm prefixo `ck_` e são criados por um usuário com permissão `integrations.manage`, em `POST /api/v1/api-tokens`. O valor completo aparece **uma única vez** na criação. A API guarda apenas o hash e exibe o prefixo nas listagens.

Cada token tem escopos. Hoje o único escopo é `ledger:write`. Rotas de integração exigem o escopo correspondente e, sem ele, respondem 403.

Envie o token no cabeçalho:

```
Authorization: Bearer ck_xxxxxxxxxxxxxxxxxxxxxxxx
```

Token ausente, inválido, revogado, expirado ou de empresa arquivada responde 401 com código `invalid_token`. Revogação tem efeito imediato.

## 3. Códigos de erro mais comuns

Os códigos abaixo foram localizados em `apps/api/src`. Os status indicados são os usados no código.

| Status | Código | Quando acontece |
|---|---|---|
| 400 | `validation_error` | Corpo, consulta ou parâmetro fora do esquema. `details` lista os campos. |
| 400 | `bad_request` | Requisição malformada sem código específico. |
| 400 | `invalid_data` | Violação de restrição do banco (dado inválido). |
| 400 | `invalid_cursor` | Cursor de paginação inválido. |
| 400 | `idempotency_key_required` | Rota de entrada sem cabeçalho `Idempotency-Key` válido. |
| 400 | `invalid_bank_account` | Conta bancária inexistente ou inativa no envio de lançamentos. |
| 400 | `note_required` | Conciliação com diferença de valor sem observação. |
| 400 | `onboarding_incomplete` | Falta etapa obrigatória para concluir a implantação. |
| 401 | `unauthenticated` | Sessão ausente ou inválida. |
| 401 | `session_expired` | Sessão expirada por inatividade ou tempo absoluto. |
| 401 | `invalid_credentials` | E-mail ou senha incorretos no login. |
| 401 | `invalid_token` | Token de API ausente, inválido, revogado ou expirado. |
| 403 | `forbidden` | Usuário sem a permissão exigida pela rota (código padrão). |
| 403 | `csrf_invalid` | Escrita sem `X-CSRF-Token` correto. |
| 403 | `module_disabled` | Módulo necessário não está habilitado para a empresa. |
| 403 | `license_inactive` | Empresa em modo somente leitura; escritas são bloqueadas. |
| 403 | `password_change_required` | Senha temporária ainda não foi trocada. |
| 403 | `limit_reached` | Limite do plano atingido (usuários ou contas bancárias). |
| 403 | `four_eyes` | Quem propôs a conciliação tentou aprová-la. |
| 403 | `tenant_unavailable` | Empresa indisponível para o acesso. |
| 404 | `not_found` | Recurso inexistente **ou de outra empresa**. As duas situações têm a mesma resposta. |
| 409 | `duplicate_file` | Arquivo ou lote de lançamentos já recebido para a mesma conta. `details.batchId` aponta o lote existente. |
| 409 | `idempotency_key_reused` | Mesma `Idempotency-Key` com conteúdo diferente. |
| 409 | `duplicate` | Já existe registro com estes dados (restrição única). |
| 409 | `reference` | Registro em uso ou com referência a item inexistente. |
| 409 | `concurrent_update` | Outra operação alterou os mesmos dados. Tente novamente. |
| 409 | `stale_version` | Configurações alteradas por outra pessoa. Recarregue antes de salvar. |
| 409 | `job_in_progress` | O processamento da importação ainda está em andamento. |
| 409 | `invalid_status` | Situação do trabalho não permite a operação (por exemplo, repetir um trabalho que não está em falha definitiva). |
| 409 | `last_admin` | A empresa ficaria sem usuário ativo que gerencie usuários. |
| 409 | `role_in_use` | Papel atribuído a usuários não pode ser excluído. |
| 409 | `integration_inactive` | Integração inativa. |
| 409 | `integration_not_configured` | Integração sem configuração ou sem verificação necessária. |
| 413 | `payload_too_large` | Corpo acima do limite. |
| 415 | `unsupported_media_type` | Tipo de conteúdo não aceito pela rota. |
| 429 | `rate_limited` | Muitas tentativas em pouco tempo. |
| 500 | `internal_error` | Erro não previsto. A mensagem não expõe detalhes; use `requestId` para localizar o registro. |

## 4. Tabela de rotas

Gerada a partir de `apps/api/src/routes.ts` (124 rotas de negócio). Colunas:

- **Auth:** `session` (cookie e `X-CSRF-Token` em escritas), `any_session` (qualquer sessão, de empresa ou da plataforma), `platform` (só operador da plataforma), `api_token` (token de API), `public`.
- **Permissão:** papel exigido do usuário da sessão. Quando vazia, basta estar autenticado.
- **Escopo:** escopo exigido do token de API.
- **Módulo:** módulo que precisa estar habilitado para a empresa. Sem módulo, a rota está sempre disponível.

As áreas seguem as `tags` declaradas em cada rota. A rota `GET /api/v1/openapi.json` não aparece na tabela porque é registrada diretamente na aplicação.


## autenticação
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| POST | `/api/v1/auth/login` | Entrar com e-mail e senha | public | — | — | — |
| GET | `/api/v1/auth/me` | Usuário autenticado, empresa, permissões e licença | any_session | — | — | — |
| POST | `/api/v1/auth/logout` | Encerrar a sessão atual | any_session | — | — | — |
| POST | `/api/v1/auth/password` | Trocar a própria senha | any_session | — | — | — |
| GET | `/api/v1/auth/sessions` | Sessões ativas do próprio usuário | any_session | — | — | — |
| DELETE | `/api/v1/auth/sessions/:id` | Encerrar uma sessão do próprio usuário | any_session | — | — | — |

## acesso
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| GET | `/api/v1/users` | Listar usuários da empresa | session | users.manage | — | — |
| POST | `/api/v1/users` | Criar usuário | session | users.manage | — | — |
| PATCH | `/api/v1/users/:id` | Alterar nome, papel ou situação de um usuário | session | users.manage | — | — |
| POST | `/api/v1/users/:id/reset-password` | Gerar senha temporária para um usuário | session | users.manage | — | — |
| POST | `/api/v1/users/:id/revoke-sessions` | Encerrar todas as sessões de um usuário | session | users.manage | — | — |
| GET | `/api/v1/roles` | Listar papéis da empresa | session | users.manage | — | — |
| POST | `/api/v1/roles` | Criar papel | session | users.manage | — | — |
| PATCH | `/api/v1/roles/:id` | Alterar papel | session | users.manage | — | — |
| DELETE | `/api/v1/roles/:id` | Excluir papel sem usuários | session | users.manage | — | — |

## auditoria
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| GET | `/api/v1/audit` | Trilha de auditoria da empresa | session | audit.view | — | — |
| GET | `/api/v1/audit/verify` | Verificar a integridade da cadeia de auditoria | session | audit.view | — | — |

## plataforma
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| GET | `/api/v1/platform/tenants` | Listar empresas com plano, licença e número de usuários | platform | — | — | — |
| POST | `/api/v1/platform/tenants` | Criar empresa com o primeiro administrador | platform | — | — | — |
| GET | `/api/v1/platform/tenants/:id` | Detalhes de uma empresa | platform | — | — | — |
| PATCH | `/api/v1/platform/tenants/:id` | Alterar dados ou situação de uma empresa | platform | — | — | — |
| PUT | `/api/v1/platform/tenants/:id/license` | Definir plano e licença de uma empresa | platform | — | — | — |
| GET | `/api/v1/platform/plans` | Listar planos | platform | — | — | — |
| GET | `/api/v1/platform/audit` | Trilha de auditoria da plataforma | platform | — | — | — |

## configuração
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| GET | `/api/v1/settings` | Ler configurações da empresa | session | settings.view | — | — |
| PUT | `/api/v1/settings` | Alterar configurações da empresa | session | settings.manage | — | — |
| GET | `/api/v1/company` | Dados da empresa | session | — | — | — |
| PATCH | `/api/v1/company` | Alterar dados da empresa | session | settings.manage | — | — |
| GET | `/api/v1/modules` | Catálogo de módulos e situação na empresa | session | — | — | — |
| PUT | `/api/v1/modules/:key` | Habilitar ou desabilitar um módulo | session | modules.manage | — | — |
| GET | `/api/v1/license` | Plano, licença e limites da empresa | session | — | — | — |

## cadastros
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| GET | `/api/v1/org-nodes` | Listar unidade/departamento/centro de custo | session | — | — | — |
| GET | `/api/v1/org-nodes/:id` | Consultar unidade/departamento/centro de custo | session | — | — | — |
| POST | `/api/v1/org-nodes` | Criar unidade/departamento/centro de custo | session | settings.manage | — | — |
| PATCH | `/api/v1/org-nodes/:id` | Alterar unidade/departamento/centro de custo | session | settings.manage | — | — |
| DELETE | `/api/v1/org-nodes/:id` | Excluir unidade/departamento/centro de custo | session | settings.manage | — | — |
| GET | `/api/v1/chart-accounts` | Listar conta contábil | session | — | — | — |
| GET | `/api/v1/chart-accounts/:id` | Consultar conta contábil | session | — | — | — |
| POST | `/api/v1/chart-accounts` | Criar conta contábil | session | settings.manage | — | — |
| PATCH | `/api/v1/chart-accounts/:id` | Alterar conta contábil | session | settings.manage | — | — |
| DELETE | `/api/v1/chart-accounts/:id` | Excluir conta contábil | session | settings.manage | — | — |
| GET | `/api/v1/categories` | Listar categoria | session | — | — | — |
| GET | `/api/v1/categories/:id` | Consultar categoria | session | — | — | — |
| POST | `/api/v1/categories` | Criar categoria | session | settings.manage | — | — |
| PATCH | `/api/v1/categories/:id` | Alterar categoria | session | settings.manage | — | — |
| DELETE | `/api/v1/categories/:id` | Excluir categoria | session | settings.manage | — | — |
| GET | `/api/v1/bank-accounts` | Listar conta bancária | session | — | — | — |
| GET | `/api/v1/bank-accounts/:id` | Consultar conta bancária | session | — | — | — |
| POST | `/api/v1/bank-accounts` | Criar conta bancária | session | settings.manage | — | — |
| PATCH | `/api/v1/bank-accounts/:id` | Alterar conta bancária | session | settings.manage | — | — |
| DELETE | `/api/v1/bank-accounts/:id` | Excluir conta bancária | session | settings.manage | — | — |
| GET | `/api/v1/classification-rules` | Listar regra de classificação | session | — | — | — |
| GET | `/api/v1/classification-rules/:id` | Consultar regra de classificação | session | — | — | — |
| POST | `/api/v1/classification-rules` | Criar regra de classificação | session | settings.manage | — | — |
| PATCH | `/api/v1/classification-rules/:id` | Alterar regra de classificação | session | settings.manage | — | — |
| DELETE | `/api/v1/classification-rules/:id` | Excluir regra de classificação | session | settings.manage | — | — |
| GET | `/api/v1/import-profiles` | Listar perfil de importação | session | — | — | — |
| GET | `/api/v1/import-profiles/:id` | Consultar perfil de importação | session | — | — | — |
| POST | `/api/v1/import-profiles` | Criar perfil de importação | session | settings.manage | — | — |
| PATCH | `/api/v1/import-profiles/:id` | Alterar perfil de importação | session | settings.manage | — | — |
| DELETE | `/api/v1/import-profiles/:id` | Excluir perfil de importação | session | settings.manage | — | — |
| GET | `/api/v1/report-templates` | Listar modelo de relatório | session | — | — | — |
| GET | `/api/v1/report-templates/:id` | Consultar modelo de relatório | session | — | — | — |
| POST | `/api/v1/report-templates` | Criar modelo de relatório | session | settings.manage | — | — |
| PATCH | `/api/v1/report-templates/:id` | Alterar modelo de relatório | session | settings.manage | — | — |
| DELETE | `/api/v1/report-templates/:id` | Excluir modelo de relatório | session | settings.manage | — | — |

## onboarding
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| GET | `/api/v1/onboarding` | Situação da implantação da empresa | session | settings.view | — | — |
| PUT | `/api/v1/onboarding/steps/:key` | Marcar etapa da implantação | session | settings.manage | — | — |
| POST | `/api/v1/onboarding/apply-template` | Aplicar modelo de plano de contas e categorias | session | settings.manage | — | — |
| POST | `/api/v1/onboarding/complete` | Concluir a implantação e ativar a empresa | session | settings.manage | — | — |

## fila
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| GET | `/api/v1/jobs` | Listar trabalhos da fila | session | imports.view | — | — |
| GET | `/api/v1/jobs/:id` | Consultar um trabalho da fila | session | imports.view | — | — |
| POST | `/api/v1/jobs/:id/retry` | Repetir um trabalho em falha definitiva | session | imports.create | — | — |

## importação
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| POST | `/api/v1/imports` | Enviar arquivo de extrato (OFX, CSV, XLSX) ou de lançamentos (CSV, XLSX) | session | imports.create | — | — |
| GET | `/api/v1/imports` | Listar importações | session | imports.view | — | — |
| GET | `/api/v1/imports/:id` | Consultar uma importação, com estatísticas e trabalho | session | imports.view | — | — |
| GET | `/api/v1/imports/:id/preview` | Pré-visualizar o arquivo de uma importação | session | imports.view | — | — |
| POST | `/api/v1/imports/:id/confirm` | Confirmar o mapeamento e enfileirar o processamento | session | imports.create | — | — |
| POST | `/api/v1/imports/:id/cancel` | Cancelar uma importação ainda não confirmada | session | imports.create | — | — |
| POST | `/api/v1/imports/:id/reprocess` | Reprocessar uma importação concluída ou falha (não duplica registros) | session | imports.create | — | — |
| GET | `/api/v1/imports/:id/rejections` | Linhas rejeitadas de uma importação, com o motivo | session | imports.view | — | — |
| GET | `/api/v1/imports/:id/file` | Baixar o arquivo original de uma importação | session | imports.view | — | — |

## conciliação
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| POST | `/api/v1/reconciliation/runs` | Executar a conciliação de uma conta em um período (assíncrono) | session | reconciliation.run | — | — |
| GET | `/api/v1/reconciliation/runs` | Listar execuções de conciliação | session | reconciliation.view | — | — |
| GET | `/api/v1/reconciliation/runs/:id` | Consultar uma execução de conciliação, com regras usadas e estatísticas | session | reconciliation.view | — | — |
| GET | `/api/v1/reconciliation/items` | Itens de extrato e lançamentos com filtros e pesquisa | session | reconciliation.view | — | — |
| GET | `/api/v1/reconciliation/items/:side/:id` | Item com a linha bruta e o histórico de decisões | session | reconciliation.view | — | — |
| POST | `/api/v1/reconciliation/items/ignore` | Ignorar um item na conciliação, com justificativa | session | reconciliation.review | — | — |
| POST | `/api/v1/reconciliation/items/classify` | Classificar uma transação sem lançamento correspondente | session | reconciliation.review | — | — |
| GET | `/api/v1/reconciliation/counts` | Contagens para as abas da conciliação (itens por situação e sugestões abertas), com os filtros da lista | session | reconciliation.view | — | — |
| GET | `/api/v1/reconciliation/matches` | Sugestões e conciliações, com os itens dos dois lados | session | reconciliation.view | — | — |
| GET | `/api/v1/reconciliation/matches/:id` | Consultar uma sugestão ou conciliação | session | reconciliation.view | — | — |
| POST | `/api/v1/reconciliation/matches/manual` | Conciliar manualmente (1:1, 1:N, N:1); diferença de valor exige observação | session | reconciliation.review | — | — |
| POST | `/api/v1/reconciliation/matches/bulk-accept` | Aceitar em lote sugestões não ambíguas e sem divergência | session | reconciliation.review | — | — |
| POST | `/api/v1/reconciliation/matches/:id/accept` | Aceitar uma sugestão (vai para aprovação quando as regras da empresa exigirem) | session | reconciliation.review | — | — |
| POST | `/api/v1/reconciliation/matches/:id/reject` | Rejeitar uma sugestão; o par não é proposto de novo | session | reconciliation.review | — | — |
| POST | `/api/v1/reconciliation/matches/:id/approve` | Aprovar uma conciliação pendente de aprovação | session | reconciliation.approve | — | — |
| POST | `/api/v1/reconciliation/matches/:id/refuse` | Recusar uma conciliação pendente de aprovação e liberar os itens | session | reconciliation.approve | — | — |
| POST | `/api/v1/reconciliation/matches/:id/undo` | Desfazer uma conciliação vigente, com justificativa; os itens voltam a pendente | session | reconciliation.undo | — | — |

## painel
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| GET | `/api/v1/dashboard` | Totais por situação, sugestões abertas, aprovações pendentes, por conta e últimas atividades | session | dashboard.view | — | — |

## exportações
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| POST | `/api/v1/exports/items` | Exporta os itens do filtro em CSV, XLSX ou PDF | session | exports.create | — | — |
| POST | `/api/v1/exports/summary` | Resumo da conciliação de uma conta e período em PDF ou XLSX | session | exports.create | — | — |
| POST | `/api/v1/exports/pending-entries` | Classificações confirmadas sem lançamento, a registrar no sistema financeiro | session | exports.create | — | — |

## integrações
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| GET | `/api/v1/integrations` | Listar integrações | session | integrations.manage | — | — |
| POST | `/api/v1/integrations` | Cadastrar integração (o segredo é só de escrita) | session | integrations.manage | — | — |
| GET | `/api/v1/integrations/:id` | Detalhar integração | session | integrations.manage | — | — |
| PATCH | `/api/v1/integrations/:id` | Alterar integração; mudança de configuração ou segredo exige novo teste | session | integrations.manage | — | — |
| DELETE | `/api/v1/integrations/:id` | Excluir integração sem uso | session | integrations.manage | — | — |
| POST | `/api/v1/integrations/:id/test` | Testar integração com chamada real (grava verified ou error) | session | integrations.manage | — | — |
| POST | `/api/v1/integrations/:id/pull` | Buscar lançamentos do período no conector REST (trabalho connector.pull) | session | imports.create | — | connector.rest |
| GET | `/api/v1/api-tokens` | Listar tokens de API (só o prefixo) | session | integrations.manage | — | api.inbound |
| POST | `/api/v1/api-tokens` | Criar token de API (o valor é exibido uma única vez) | session | integrations.manage | — | api.inbound |
| POST | `/api/v1/api-tokens/:id/revoke` | Revogar token de API (efeito imediato) | session | integrations.manage | — | api.inbound |

## api de entrada
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| POST | `/api/v1/integrations/ledger/entries` | Enviar lançamentos do sistema financeiro (até 1.000, idempotente por Idempotency-Key) | api_token | — | ledger:write | api.inbound |
| GET | `/api/v1/integrations/ledger/batches/:id` | Situação de um lote recebido pela API, com rejeições | api_token | — | ledger:write | api.inbound |

## notificações
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| GET | `/api/v1/notification-rules` | Listar regras de notificação | session | settings.manage | — | — |
| POST | `/api/v1/notification-rules` | Criar regra de notificação (in_app, email ou webhook) | session | settings.manage | — | — |
| PATCH | `/api/v1/notification-rules/:id` | Alterar regra de notificação | session | settings.manage | — | — |
| DELETE | `/api/v1/notification-rules/:id` | Excluir regra de notificação | session | settings.manage | — | — |
| GET | `/api/v1/notifications` | Avisos do usuário (mais recentes primeiro) | session | — | — | — |
| POST | `/api/v1/notifications/:id/read` | Marcar aviso como lido | session | — | — | — |
| POST | `/api/v1/notifications/read-all` | Marcar todos os avisos do usuário como lidos | session | — | — | — |
| GET | `/api/v1/notification-deliveries` | Registro de entregas externas (webhook e e-mail) | session | settings.manage | — | — |

## ia
| Método | Caminho | Resumo | Auth | Permissão | Escopo | Módulo |
|---|---|---|---|---|---|---|
| POST | `/api/v1/ai/suggest-categories` | Sugerir categoria por IA para transações pendentes (só sugestão, nunca confirma) | session | reconciliation.review | — | ai.assist |

## 5. API de entrada de lançamentos

Permite que um sistema financeiro envie lançamentos ao Concilia. Os lançamentos entram como lote de importação (`origin = api`) e seguem o mesmo processamento de uma importação por arquivo. Escopo exigido: `ledger:write`. Módulo: `api.inbound`, que a empresa precisa habilitar.

### 5.1 Envio

`POST /api/v1/integrations/ledger/entries`

Cabeçalhos:

- `Authorization: Bearer ck_...` (token de API com escopo `ledger:write`)
- `Idempotency-Key`: obrigatório, de 1 a 200 caracteres visíveis, sem espaços. Use um identificador do envio que o sistema de origem consiga repetir.
- `Content-Type: application/json`

Corpo:

- `bankAccountId` (opcional, UUID): conta bancária do Concilia à qual os lançamentos pertencem. Precisa estar ativa.
- `entries` (obrigatório, de 1 a 1.000 itens). Cada item segue o contrato `ledgerEntryInputV1Schema`:
  - `date` (obrigatório): `AAAA-MM-DD`.
  - `amountCents` (obrigatório): inteiro diferente de zero, em centavos. Entrada positiva, saída negativa.
  - `description` (obrigatório): de 1 a 500 caracteres.
  - Opcionais: `externalId` (até 120), `document`, `reference`, `counterparty` (até 200), `dueDate` (`AAAA-MM-DD`), `bankAccountRef`, `costCenter`, `category`.

Exemplo completo, com dados fictícios:

```bash
BASE=https://concilia.exemplo.test
TOKEN=ck_exemploexemploexemplo

curl -sS -X POST "$BASE/api/v1/integrations/ledger/entries" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: erp-exemplo-2026-11-14-001" \
  -H "Content-Type: application/json" \
  -d '{
        "bankAccountId": "0b9f3c2e-1d4a-4f6b-9a7e-2c5d8e1f0a11",
        "entries": [
          {
            "externalId": "ERP-1001",
            "date": "2026-11-14",
            "amountCents": -15000,
            "description": "Pagamento fornecedor exemplo",
            "document": "NF-123",
            "counterparty": "Fornecedor Exemplo Ltda",
            "dueDate": "2026-11-20"
          },
          {
            "externalId": "ERP-1002",
            "date": "2026-11-14",
            "amountCents": 98000,
            "description": "Recebimento cliente exemplo",
            "document": "NF-456"
          }
        ]
      }'
```

Respostas:

- **202 (primeiro envio):** o lote foi aceito e o processamento foi enfileirado.

  ```json
  { "batchId": "7f0c2a1e-0000-4000-8000-000000000001", "jobId": "3d2e1f00-0000-4000-8000-000000000002" }
  ```

- **202 (repetição com a mesma chave e o mesmo conteúdo):** nada é criado de novo. A resposta devolve o mesmo lote com `replayed: true`.

  ```json
  { "batchId": "7f0c2a1e-0000-4000-8000-000000000001", "jobId": "3d2e1f00-0000-4000-8000-000000000002", "replayed": true }
  ```

- **409 `idempotency_key_reused`:** a mesma `Idempotency-Key` foi usada com conteúdo diferente. `details.batchId` aponta o lote original. Gere uma chave nova só para um envio novo de fato.
- **409 `duplicate_file`:** o mesmo conjunto de lançamentos já foi recebido em outro lote, com outra chave. `details.batchId` aponta o lote existente.
- **400 `idempotency_key_required`:** cabeçalho ausente ou inválido.
- **400 `validation_error`:** algum item não atende ao contrato. `details` indica o caminho do campo.
- **401 `invalid_token`** ou **403** (escopo ou módulo): verifique o token e a habilitação do módulo `api.inbound`.

A repetição com a mesma chave é segura: o sistema de origem pode reenviar o mesmo lote após uma falha de rede sem criar lançamentos duplicados.

### 5.2 Consulta do lote

`GET /api/v1/integrations/ledger/batches/{id}`

Usa o mesmo token. Retorna a situação do lote, as estatísticas e até 1.000 rejeições, cada uma com número da linha, tipo e motivo. Um lote de outra empresa responde 404.

```bash
curl -sS "$BASE/api/v1/integrations/ledger/batches/7f0c2a1e-0000-4000-8000-000000000001" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "id": "7f0c2a1e-0000-4000-8000-000000000001",
  "status": "completed",
  "stats": { "imported": 2, "rejected": 0 },
  "error": null,
  "createdAt": "2026-11-14T12:00:00.000Z",
  "processedAt": "2026-11-14T12:00:03.000Z",
  "rejections": []
}
```

Os valores de `status` seguem a tabela `import_batches` (ver `docs/03-modelo-de-dados.md`). Enquanto o processamento não termina, a consulta pode mostrar uma situação intermediária.

## 6. Especificação OpenAPI

`GET /api/v1/openapi.json` devolve a especificação OpenAPI 3.1 gerada pelas mesmas definições de rota que validam as requisições. Cada operação traz `x-auth`, `x-permission`, `x-module` e `x-scope`, quando houver. A rota é pública e não exige sessão.

```bash
curl -sS "$BASE/api/v1/openapi.json" -o openapi.json
```

Os esquemas de corpo e de consulta vêm de Zod. Respostas são descritas de forma genérica (200, 400, 401, 403, 404, 409).

## 7. Webhooks de saída

Webhooks entregam eventos da empresa a um endereço HTTP(S) configurado por ela.

### 7.1 Configuração

1. Cadastre uma integração do tipo `webhook` em `POST /api/v1/integrations`. Campos: `kind: "webhook"`, `name`, `config: { "url": "https://..." }` e `secret`, que é o segredo de assinatura. O segredo é só de escrita: nenhuma resposta o devolve.
2. Teste com `POST /api/v1/integrations/{id}/test`. O teste envia um evento `integration.test` com chamada real. A integração fica `verified` só se o destino responder com 2xx. Caso contrário, fica `error`.
3. Crie uma regra em `POST /api/v1/notification-rules` com `channel: "webhook"`, o `event` desejado e o `integrationId`.

Módulo necessário: `notifications.webhook`.

### 7.2 Eventos

| Evento | Quando é disparado |
|---|---|
| `import.completed` | Importação concluída |
| `import.failed` | Importação com falha |
| `reconciliation.completed` | Execução de conciliação concluída |
| `approval.requested` | Conciliação aguardando aprovação |
| `job.dead` | Trabalho em falha definitiva |

O teste da integração usa o evento `integration.test`, que não faz parte da lista de regras.

### 7.3 Corpo

O corpo é JSON no formato `WebhookPayloadV1`:

```json
{
  "id": "e1b2c3d4-0000-4000-8000-000000000003",
  "event": "import.completed",
  "occurredAt": "2026-11-14T12:00:03.000Z",
  "data": { "importId": "9a8b7c6d-0000-4000-8000-000000000004" }
}
```

`id` é o identificador da entrega. O campo `data` leva só o necessário para o evento, sem segredos.

### 7.4 Cabeçalhos

| Cabeçalho | Conteúdo |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Concilia-Webhook/1` |
| `X-Concilia-Event` | Nome do evento |
| `X-Concilia-Delivery` | Mesmo valor de `id` do corpo |
| `X-Concilia-Timestamp` | Segundos Unix no momento do envio |
| `X-Concilia-Signature` | `sha256=` seguido do HMAC em hexadecimal |

A assinatura é o HMAC-SHA256, com o segredo da integração, sobre a string `${timestamp}.${corpo}`. Use o corpo bruto exatamente como recebido.

### 7.5 Como conferir a assinatura (Node.js)

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

// corpo: texto bruto da requisição, sem reserializar o JSON
export function assinaturaValida({ segredo, timestamp, corpo, assinatura }) {
  const esperada = 'sha256=' + createHmac('sha256', segredo).update(`${timestamp}.${corpo}`).digest('hex');
  const a = Buffer.from(esperada);
  const b = Buffer.from(assinatura ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Recomendação deste documento, não verificada pelo código: no receptor, recuse entregas com timestamp fora de uma janela curta (por exemplo, cinco minutos) para reduzir o reenvio de requisições antigas. O Concilia não impõe essa janela.

### 7.6 Envio, repetição e falhas

- O envio só é considerado bem-sucedido com resposta 2xx. Redirecionamentos não são seguidos.
- O tempo limite de cada tentativa é de 10 segundos. A resposta lida pelo Concilia é limitada a 64 KB.
- Destinos em rede privada só são aceitos quando `ALLOW_PRIVATE_INTEGRATION_HOSTS` está ligado, e essa opção é proibida em produção.
- Cada falha grava a entrega como `failed`, com o motivo e o status HTTP quando houver.
- A entrega é repetida automaticamente. São no máximo 3 tentativas. A espera entre elas é de 2 elevado a n vezes 5 segundos, limitada a 10 minutos.
- Depois da última tentativa, o trabalho vai para `dead` (falha definitiva) e aparece em `GET /api/v1/jobs`. Ele pode ser repetido com `POST /api/v1/jobs/{id}/retry`.
- Falha definitiva de entrega não gera nova entrega externa.
- Entregas são listadas em `GET /api/v1/notification-deliveries`, com situação `pending`, `sent`, `failed` ou `skipped`.

Uma entrega só vira `sent` com resposta 2xx do destino.

## 8. Conectores versionados

### 8.1 Contratos

Os contratos ficam em `packages/core/src/contracts/v1/`. São as interfaces que os adaptadores precisam cumprir.

- **`LedgerConnectorV1`** (`ledger.ts`): conector de leitura de lançamentos do sistema financeiro.
  - `version: 'v1'`.
  - `test()`: faz uma chamada real de verificação e lança erro se o serviço não responder como esperado.
  - `pull({ dateFrom, dateTo })`: devolve os itens do período, já no formato v1, e a lista bruta.
- **`AiAssistProviderV1`** (`ai.ts`): provedor de sugestões de categoria.
  - `version: 'v1'`.
  - `test()`: chamada real mínima de verificação.
  - `suggestCategories({ transactions, categories })`: devolve sugestões. Lança erro se a resposta não estiver no formato, e nunca devolve sugestão inventada.
- **`WebhookPayloadV1`** e **`NOTIFICATION_EVENTS`** (`notifications.ts`): corpo e eventos de webhook.
- **Esquemas de configuração** (`integrations.ts`): um por tipo de integração, com `INTEGRATION_KINDS`, o módulo exigido por cada tipo e os status possíveis (`not_configured`, `configured`, `verified`, `error`).
- **`ledgerEntryInputV1Schema`** (`ledger.ts`): contrato de lançamento usado pela API de entrada e pelo conector.

Regra de versionamento, descrita em `packages/core/src/contracts/v1/index.ts`: mudança incompatível cria `v2` ao lado de `v1`. A versão anterior continua existindo até que nenhuma integração a use. Hoje não existe `v2`.

Mapeamento de tipo para módulo:

| Tipo | Módulo |
|---|---|
| `webhook` | `notifications.webhook` |
| `smtp` | `notifications.email` |
| `rest_ledger` | `connector.rest` |
| `ai_provider` | `ai.assist` |

### 8.2 Conector REST de lançamentos

Lê lançamentos de uma API externa, em JSON, para um período.

Configuração (`config` da integração `rest_ledger`):

| Campo | Padrão | Descrição |
|---|---|---|
| `baseUrl` | obrigatório | Endereço http(s) da API |
| `path` | `/` | Caminho da consulta |
| `authType` | `bearer` | `none`, `bearer`, `header` ou `basic` |
| `headerName` | — | Nome do cabeçalho quando `header`; usuário quando `basic` |
| `itemsPath` | — | Caminho da lista na resposta (ex.: `dados.itens`); vazio quando a resposta já é a lista |
| `dateFromParam` | `dateFrom` | Nome do parâmetro de início na consulta |
| `dateToParam` | `dateTo` | Nome do parâmetro de fim na consulta |
| `amountUnit` | `decimal` | `decimal` (ex.: `-150,00`) ou `cents` (ex.: `-15000`) |
| `fieldMap` | obrigatório | Mapa de campos (abaixo) |
| `bankAccountId` | — | Conta do Concilia para os lançamentos lidos |

O segredo (token, chave ou senha) é enviado no campo `secret` da integração e é cifrado no banco.

Mapa de campos: cada chave aponta para um caminho com pontos dentro de um item da resposta. `date`, `amount` e `description` são obrigatórios. Os demais são opcionais: `externalId`, `document`, `reference`, `counterparty`, `dueDate`, `bankAccountRef`, `costCenter` e `category`. Campo ilegível fica ausente, e o lançamento segue para rejeição com o motivo.

Exemplo de configuração, com dados fictícios. A API externa responde `{"dados":{"itens":[{"id":"L1","data":"2026-11-14","valor":"-150,00","historico":"Pagamento exemplo"}]}}`:

```json
{
  "kind": "rest_ledger",
  "name": "ERP exemplo",
  "config": {
    "baseUrl": "https://erp.exemplo.test",
    "path": "/lancamentos",
    "authType": "bearer",
    "itemsPath": "dados.itens",
    "amountUnit": "decimal",
    "fieldMap": {
      "externalId": "id",
      "date": "data",
      "amount": "valor",
      "description": "historico"
    }
  },
  "secret": "<token exemplo>"
}
```

Fluxo:

1. `POST /api/v1/integrations/{id}/test` faz uma consulta real com o dia de hoje e grava `verified` ou `error`.
2. `POST /api/v1/integrations/{id}/pull` com `{ "dateFrom": "2026-11-01", "dateTo": "2026-11-14" }` enfileira o trabalho `connector.pull` e responde 202 com `jobId`. O período vai de 1 a 366 dias. A integração precisa estar ativa e configurada.

A consulta é feita por `safeFetch`, com tempo limite e sem seguir redirecionamentos. Itens acima de 100.000 são recusados.

### 8.3 Provedor de IA

Adaptador `anthropic` do contrato `AiAssistProviderV1`.

- Configuração (`ai_provider`): `provider: "anthropic"`, `model` (padrão `claude-haiku-5-5`) e `baseURL` opcional, usado para apontar a um servidor de teste.
- Segredo: a chave de API, cifrada no banco.
- `POST /api/v1/ai/suggest-categories` recebe `{ "bankTransactionIds": [...] }`, com até 100 transações. Exige integração `ai_provider` verificada, senão responde 409 `integration_not_configured`. Módulo: `ai.assist`.
- O que sai do sistema: descrição normalizada, sentido (`in` ou `out`), tipo e referências locais (`t1`, `c1`). Identificadores internos não são enviados.
- A saída é só sugestão. Quem confirma a categoria é uma pessoa.
- Resposta fora do formato, erro do provedor ou recusa de chave geram erro. Nenhuma sugestão é gravada nesses casos.

## 9. Dependências externas e o que foi verificado

Esta seção registra o estado real das integrações neste repositório. Ela é deliberadamente conservadora.

- **Webhook:** testado apenas contra servidores locais de teste. Não há prova de entrega a um destino real de produção.
- **Conector REST de lançamentos:** testado apenas contra servidores locais de teste. Não há prova de conexão a um ERP real.
- **SMTP:** testado apenas contra servidores locais de teste. TLS e autenticação SMTP reais não foram exercitados.
- **Provedor de IA (Anthropic):** o adaptador nunca chamou o serviço real, por falta de chave neste ambiente. Os testes usam servidor local.
- **Nenhuma integração é marcada como `verified` sem resposta real do serviço.** O status `verified` só é gravado após chamada real bem-sucedida. Testes locais não contam como verificação de produção.
