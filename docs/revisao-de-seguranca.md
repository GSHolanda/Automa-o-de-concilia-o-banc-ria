# Revisão de segurança e isolamento

Revisão única, por leitura do código e confirmação por execução, feita em 16/11/2026 sobre o commit `aa31fc0`.
Nenhum código de produção foi alterado. Os testes temporários usados nas confirmações foram apagados; cada
achado descreve o que foi executado e o resultado observado.

**Resultado:** 14 achados — nenhum crítico, 3 altos, 5 médios, 6 baixos. Não foi encontrada forma de uma
empresa ler ou gravar dados de outra pelas rotas atuais. Os achados altos são: conciliação automática errada
com a configuração padrão, queda de toda a instalação por uma planilha, e extração de segredo de integração.

"CONFIRMADO" significa reproduzido por execução (teste de API contra PostgreSQL com o papel da aplicação, ou
script que chama o código do produto). "SUSPEITA" significa visto no código, sem execução.

| # | Gravidade | Achado | Situação |
|---|---|---|---|
| 1 | Alta | Motor concilia sozinho um par que só é "único" porque o concorrente ficou fora da execução | CONFIRMADO |
| 2 | Alta | Planilha XLSX de poucos MB esgota a memória e trava o processo que atende todas as empresas | CONFIRMADO |
| 3 | Alta | Segredo de integração é enviado a um novo destino sem ser informado de novo | CONFIRMADO |
| 4 | Média | Chamada externa dentro da transação prende o pool de conexões compartilhado | CONFIRMADO |
| 5 | Média | Anônimo impede logins: bloqueio de conta e limite por IP mal ancorado | CONFIRMADO |
| 6 | Média | `users.manage` concede a si qualquer permissão e contorna a aprovação em duas etapas | CONFIRMADO |
| 7 | Média | Credencial embutida na URL de integração aparece na auditoria e nas respostas | CONFIRMADO |
| 8 | Média | RLS de `users` deixa um usuário promover a própria linha a operador da plataforma | CONFIRMADO no banco |
| 9 | Baixa | Repetir e listar trabalhos exige permissão mais fraca que a operação original | CONFIRMADO |
| 10 | Baixa | Segredo gravado durante a troca da chave mestra fica ilegível e trava a troca seguinte | CONFIRMADO |
| 11 | Baixa | Administrador de uma empresa descobre se um e-mail existe em outra | CONFIRMADO |
| 12 | Baixa | Filtro de SSRF não cobre faixas IPv6 de transição | SUSPEITA |
| 13 | Baixa | Senha temporária sem validade e troca de senha sem limite de tentativas | SUSPEITA |
| 14 | Baixa | `/metrics` aberto por padrão em produção | SUSPEITA |

---

## Achados

### 1. Motor concilia sozinho um par que só é "único" porque o concorrente ficou fora da execução — ALTA — CONFIRMADO

**Onde:** `apps/api/src/modules/reconciliation/run.ts:83-109` (`loadInput`);
`packages/core/src/matching/engine.ts:232` e `:332` (unicidade), `:538` (transferências).

**Falha.** As regras `ID_VALOR`, `VALOR_DATA_REFERENCIA` e `VALOR_DATA_UNICO` confirmam sem revisão quando o
candidato é único, e as três vêm ligadas por padrão. A unicidade, porém, é medida só sobre o que a execução
carregou: transações do extrato da conta dentro do período exato, e lançamentos da conta **ou sem conta**
(`bank_account_id IS NULL`). Um concorrente fora desse recorte não conta.

**Cenários reproduzidos, com a configuração padrão:**

- *Borda do período.* Extrato com R$ 500,00 em 31/03 ("cliente um") e R$ 500,00 em 01/04 ("cliente dois");
  lançamento de R$ 500,00 em 01/04 ("cliente dois"). Execução de 01/03 a 31/03: o lançamento de abril foi
  conciliado automaticamente com a transação de **31/03** (`VALOR_DATA_UNICO`, `auto_confirmed = true`). A
  transação correta ficou pendente. É o caso comum de fechamento mensal.
- *Lançamento sem conta.* Contas A e B com a mesma transação de −R$ 1.000,00 no mesmo dia; um lançamento sem
  conta. Execução da conta A: conciliado automaticamente com A (`VALOR_DATA_REFERENCIA`); a de B ficou pendente.
  Quem roda primeiro leva o lançamento.

Não executado, mesma causa: em transferências internas, a aresta entre duas contas não primárias é descartada
(`engine.ts:538`), então um segundo débito concorrente em uma terceira conta não reduz a unicidade (só afeta
quem ligar `autoConfirm.internalTransfers`). E qualquer sequência de 6 dígitos ou mais vira identificador
(`packages/core/src/text.ts:51`), o que inclui CNPJ ou CPF do cliente: a regra de identificador aceita então
10 dias de distância com uma evidência que se repete em todo pagamento do mesmo cliente.

**Correção.** Carregar como "contexto" (contam como concorrentes, não podem ser conciliados) as transações do
extrato até `max(dateToleranceDays, identifierMaxDateDiffDays)` dias além das duas bordas do período. Para
lançamento sem conta, contar candidatos de todas as contas da empresa, ou apenas sugerir quando a empresa tem
mais de uma conta ativa. Contar as arestas entre contas não primárias no cálculo de unicidade das
transferências. Subir `ENGINE_VERSION`.

### 2. Planilha XLSX de poucos MB esgota a memória e trava o processo que atende todas as empresas — ALTA — CONFIRMADO

**Onde:** `packages/core/src/parsers/xlsx.ts:37` (`workbook.xlsx.load`) e `:48` (limite de linhas só depois da
carga); `apps/api/src/modules/imports/routes.ts:193` (leitura dentro de `POST /imports`) e `:298`
(`GET /imports/:id/preview`, que relê o arquivo a cada chamada com `imports.view`);
`apps/api/src/modules/imports/process.ts:709` (`MAX_IMPORT_ROWS` conferido depois da leitura completa).

**Falha.** O único limite antes da leitura é o tamanho comprimido (`MAX_UPLOAD_MB`, padrão 15). O `exceljs`
descomprime todas as entradas do zip na memória, inclusive `xl/media/*`, que a importação nem usa. A leitura
acontece no processo da API, que também roda o trabalhador.

**Medições, com o leitor do produto (`readXlsx`) em processo isolado:**

| Arquivo | Tamanho enviado | Pico de memória | Tempo | Maior bloqueio do laço de eventos |
|---|---|---|---|---|
| Planilha de 2 linhas + 1 "imagem" de 1 GiB de zeros | 1,0 MB | 2,2 GB | 5,8 s | 0,1 s |
| Idem, com 4 "imagens" | 4,0 MB | 5,4 GB | 20,7 s | 2,1 s |
| Aba válida com 100.000 linhas × 40 colunas (dentro do limite de linhas) | 10,0 MB | 1,6 GB | 12,5 s | 5,2 s |

A leitura do arquivo de 4 MB terminou com sucesso: a aplicação aceitaria o envio. No limite de 15 MB o consumo
projetado passa de 15 GB, e o processo é morto pelo sistema.

**Cenário.** Qualquer usuário com `imports.create`, de qualquer empresa (inclusive em teste), derruba a API e o
trabalhador de toda a instalação com um envio. Com `imports.view`, pode repetir o custo pedindo a prévia.

**Correção.** Antes de `load`, ler o diretório central do zip e recusar por soma de tamanhos descomprimidos,
número de entradas e razão de compressão; ignorar `xl/media` e demais partes não usadas. Trocar por leitura em
fluxo (`ExcelJS.stream.xlsx.WorkbookReader`) com interrupção ao passar de `MAX_IMPORT_ROWS` e de um teto de
colunas. Executar a leitura fora do processo da API (thread ou processo com limite de memória) e guardar a
prévia calculada em vez de reler o arquivo.

### 3. Segredo de integração é enviado a um novo destino sem ser informado de novo — ALTA — CONFIRMADO

**Onde:** `apps/api/src/modules/integrations/routes.ts:155-158` (`PATCH /integrations/:id` mantém o texto
cifrado quando só `config` muda) e `:228` (`POST /integrations/:id/test`);
`apps/api/src/integrations/rest-ledger.ts:19-26`, `apps/api/src/integrations/anthropic.ts:56-66`,
`apps/api/src/integrations/smtp.ts:16-28`.

**Falha.** A regra é que o segredo só entra e nunca sai. Mas quem tem `integrations.manage` (ou uma sessão
de administrador sequestrada) altera apenas o endereço e pede o teste: o segredo guardado segue para o
endereço novo.

**Reprodução.** Conector REST criado com `baseUrl` do servidor A e segredo `SEGREDO-ERP-…`; `PATCH` só com
`config.baseUrl` do servidor B; `POST …/test`: o servidor B recebeu `Authorization: Bearer SEGREDO-ERP-…`.
Com `ai_provider`, trocar `baseURL` entregou a chave de API ao novo servidor do mesmo modo. Pelo código, vale
também para a senha SMTP (troca de `host`). O segredo de webhook não sai: só assina.

**Correção.** Quando mudar qualquer campo que define para onde ou como o segredo é enviado (`url`, `baseUrl`,
`baseURL`, `host`, `port`, `secure`, `authType`, `headerName`), exigir o segredo na mesma requisição ou apagá-lo
e voltar a `not_configured`. Como reforço, incluir o destino nos dados autenticados da cifra.

### 4. Chamada externa dentro da transação prende o pool de conexões compartilhado — MÉDIA — CONFIRMADO

**Onde:** `apps/api/src/http/route.ts:207` (todo manipulador roda dentro de `withContext`);
`apps/api/src/modules/integrations/routes.ts:228` (teste, até 10 s; SMTP e IA mais);
`apps/api/src/modules/ai/routes.ts:100` (até 60 s, com uma repetição);
`apps/api/src/jobs/worker.ts:118-129` (entregas e conector dentro da transação do trabalho);
`apps/api/src/config/env.ts:45` (`DB_POOL_MAX` padrão 10, um pool para API e trabalhador).

**Reprodução.** API com `DB_POOL_MAX=3`. A empresa A disparou três `POST /integrations/:id/test` contra um
servidor que aceita a conexão e não responde. Enquanto isso, `GET /auth/me` da empresa B levou **9.717 ms**
(normal: 6 ms). Até a busca da sessão espera conexão. Com o padrão, bastam dez requisições simultâneas,
repetidas a cada dez segundos; a rota de IA exige só `reconciliation.review`. Não há limite de requisições
fora do login.

Mesma classe, não executado: `jobs_claim` atende em ordem de chegada entre todas as empresas
(`apps/api/migrations/0004_functions.sql:76`), sem teto por empresa, e cada `POST /reconciliation/runs` cria um
trabalho; arquivos enviados e nunca confirmados não entram no expurgo
(`apps/api/src/modules/imports/retention.ts:28` exige `processed_at`), e não há cota de armazenamento.

**Correção.** Ler e decifrar em transação curta, chamar o serviço externo sem conexão em uso, gravar o
resultado em outra transação. Limite de requisições por empresa nas rotas de teste e de IA. Pool separado
para o trabalhador e `idle_in_transaction_session_timeout` no papel da aplicação. Captura da fila com teto de
trabalhos simultâneos por empresa; cota de arquivos por empresa e expurgo de envios não confirmados.

### 5. Anônimo impede logins: bloqueio de conta e limite por IP mal ancorado — MÉDIA — CONFIRMADO

**Onde:** `apps/api/src/modules/auth/routes.ts:143` (10 por minuto por IP), `:171-196` (bloqueio);
`apps/api/migrations/0004_functions.sql:19-29`; `apps/api/src/app.ts:81` (`trustProxy` booleano);
`docs/05-instalacao-e-atualizacao.md:258`.

**Três efeitos reproduzidos:**

- *Bloqueio dirigido.* Cinco senhas erradas de qualquer origem bloqueiam a conta por 15 minutos; o titular,
  com a senha certa, recebe 423. Repetindo cinco tentativas a cada 15 minutos, a conta fica inacessível
  indefinidamente. Vale para o operador da plataforma. Cada tentativa ainda grava um registro na trilha da
  empresa.
- *`TRUST_PROXY=false` atrás de proxy* (o padrão, e produção exige HTTPS, logo há proxy). Todos chegam com o
  IP do proxy: dez tentativas de um terceiro e o login legítimo de outro cliente recebeu **429**. Dez
  requisições por minuto param o login de todas as empresas.
- *`TRUST_PROXY=true`.* O Fastify passa a confiar em qualquer salto: 14 tentativas seguidas variando
  `X-Forwarded-For` receberam todas 401, sem limite; e a auditoria gravou o IP forjado (`198.51.100.77`).
  Depende de o proxy sobrescrever o cabeçalho, o que a documentação não exige.

**Correção.** Aceitar em `TRUST_PROXY` número de saltos ou lista de redes e documentar o proxy esperado; em
produção, recusar subir sem essa definição. Chavear o limite por IP **e** por e-mail. Trocar o bloqueio rígido
por espera crescente por conta e origem, de modo que o titular com a senha certa, vindo de outra origem, não
fique de fora. Limitar os registros de falha gravados por conta e minuto.

### 6. `users.manage` concede a si qualquer permissão e contorna a aprovação em duas etapas — MÉDIA — CONFIRMADO

**Onde:** `apps/api/src/modules/access/routes.ts:364-397` (`POST /roles` aceita qualquer chave do catálogo),
`:248-294` (`PATCH /users/:id` sem restrição ao próprio usuário), `:296-324` (`reset-password` devolve a senha
temporária); `apps/api/src/modules/reconciliation/decisions.ts:319` (quatro olhos por `proposed_by`);
`apps/api/src/modules/settings/routes.ts:58-85`.

**Reprodução.** Papel personalizado só com `users.manage`: o usuário criou um papel com as 15 permissões,
atribuiu-o a si com `PATCH /users/<próprio id>` e passou a acessar `/integrations`. Em seguida redefiniu a
senha do administrador e entrou como ele (login 200).

**Consequência.** Não existe papel de "gestão de pessoas" limitado: `users.manage` equivale a administrador.
E a regra dos quatro olhos, que compara apenas o id de quem propôs, é contornada por uma só pessoa: ela propõe,
redefine a senha de um aprovador (ou cria um) e aprova com a outra conta. Quem tem `settings.manage` chega ao
mesmo fim desligando `approvals.fourEyes`, aprovando e religando. Tudo fica na trilha, mas nada impede.

**Correção.** Não permitir conceder permissão que o autor não possui nem alterar o próprio papel ou situação.
Separar `roles.manage` de `users.manage`. Avisar os demais administradores em redefinição de senha, mudança de
papel e alteração de `approvals`. Recusar a aprovação por conta criada ou com senha redefinida por quem propôs,
depois da proposta.

### 7. Credencial embutida na URL de integração aparece na auditoria e nas respostas — MÉDIA — CONFIRMADO

**Onde:** `apps/api/src/audit/audit.ts:23-39` (a redação olha só o nome da chave);
`apps/api/src/modules/integrations/store.ts:48` (`config` devolvido inteiro);
`apps/api/src/modules/integrations/routes.ts:121`, `:184-185`, `:207` (visão gravada em `before`/`after`);
`packages/core/src/contracts/v1/integrations.ts:19-24` (URL aceita usuário, senha e consulta).

**Falha.** Em webhooks de mensageria o próprio endereço é a credencial, e a URL aceita `usuario:senha@`.
O segredo cifrado é protegido; a URL não.

**Reprodução.** Webhook criado com `http://usuario:SENHA-BASICA@…/services/<token>?apikey=<token>`. Um usuário
com o papel Auditor (sem acesso a `/integrations`, 403) leu o token e a senha em `GET /audit`. Como a trilha
é imutável, o valor não pode mais ser removido de lá.

**Correção.** Recusar credenciais no endereço (`usuario:senha@`) na validação. Na visão e na auditoria,
mostrar só esquema, host e porta, com caminho e consulta mascarados; a URL completa fica legível apenas para
`integrations.manage`. Considerar guardar caminho e consulta junto do segredo cifrado.

### 8. RLS de `users` deixa um usuário promover a própria linha a operador da plataforma — MÉDIA — CONFIRMADO no banco

**Onde:** `apps/api/migrations/0001_base.sql:195-201`.

**Falha.** `users_update` aceita, em `USING` e em `WITH CHECK`, `id = app_user_id()` sem fixar `tenant_id` nem
`is_platform_admin`. E as três políticas de `users` liberam tudo com `app_is_platform()`, embora as rotas de
plataforma só precisem contar usuários e criar o primeiro administrador.

**Reprodução, com o papel da aplicação:** no contexto de uma empresa e de um usuário comum,
`UPDATE users SET tenant_id = NULL, role_id = NULL, is_platform_admin = true WHERE id = <próprio id>` alterou
uma linha. Em contexto de plataforma, o mesmo papel leu os 9 usuários de 7 empresas, com os hashes de senha.

**Alcance.** Nenhuma rota atual executa esse `UPDATE` com dados do usuário; não é explorável hoje pela API.
O ponto é que a RLS, que existe para conter erro de aplicação, não conteria este: um único `UPDATE` de perfil
com coluna a mais, numa rota futura, vira operador da plataforma.

**Correção (migração nova).** Gatilho em `users`, no molde de `tenants_guard`, que fora do contexto de
plataforma recuse mudança de `tenant_id` e de `is_platform_admin`; `WITH CHECK` de `users_update` com
`tenant_id = app_tenant_id()` no contexto de empresa. No contexto de plataforma, limitar a política a
`tenant_id IS NULL` e servir a contagem por função `SECURITY DEFINER` de escopo estreito.

### 9. Repetir e listar trabalhos exige permissão mais fraca que a operação original — BAIXA — CONFIRMADO

**Onde:** `apps/api/src/modules/jobs/routes.ts:82` (`POST /jobs/:id/retry` com `imports.create`), `:24` e `:63`
(listagem e consulta com `imports.view`, de todos os tipos, com `payload`, `result` e `lastError`).

**Reprodução.** Usuário com papel só de `imports.view` e `imports.create` recebeu 403 em
`POST /reconciliation/runs`, mas repetiu um trabalho `reconciliation.run` em falha definitiva (200); a
execução rodou e conciliou a transação. O mesmo vale para `connector.pull` e `notification.deliver`.

**Correção.** Mapear tipo de trabalho para permissão (repetir exige a permissão da operação que o criou) e
filtrar a listagem pelos tipos que o usuário pode ver.

### 10. Segredo gravado durante a troca da chave mestra fica ilegível e trava a troca seguinte — BAIXA — CONFIRMADO

**Onde:** `apps/api/src/security/secrets.ts:41-53` (a versão gravada no texto cifrado não escolhe a chave);
`apps/api/src/modules/integrations/store.ts:84-92`; `apps/api/src/ops/secrets-rotate.ts:76-115`.

**Reprodução.** Depois de `secrets:rotate`, com a API ainda na chave antiga: o teste de uma integração
existente falhou e gravou `error` (efeito já descrito em `docs/09-seguranca-lgpd.md`). Um segredo cadastrado
nessa janela foi cifrado com a chave antiga; após reiniciar com a nova, não decifra mais, e a troca seguinte
é cancelada com "1 segredo(s) não puderam ser decifrados com a chave atual". Integrações de IA ficam fora de
uso até novo teste manual, porque a rota exige `verified`.

**Correção.** Aceitar um conjunto de chaves por versão (atual e anterior) e decifrar pela versão do texto
cifrado. Procedimento: subir a API com as duas, recifrar, depois retirar a antiga. Sem isso, parar API e
trabalhador antes da troca e dizer isso no procedimento.

### 11. Administrador de uma empresa descobre se um e-mail existe em outra — BAIXA — CONFIRMADO

**Onde:** `apps/api/src/modules/access/routes.ts:229-233`; decorre de e-mail único na instalação (ADR-03).

**Reprodução.** `POST /users` com o e-mail do administrador de outra empresa respondeu 409 `email_taken`; com
e-mail livre, 201. Revela quem é cliente da instalação e o e-mail do operador da plataforma, que alimenta o
bloqueio do achado 5. É o único vazamento entre empresas encontrado.

**Correção.** Decisão de produto: registrar como risco aceito do ADR-03, ou tornar o e-mail único por
empresa com login por empresa. Enquanto isso, limitar tentativas de `POST /users` por empresa.

### 12. Filtro de SSRF não cobre faixas IPv6 de transição — BAIXA — SUSPEITA

**Onde:** `apps/api/src/integrations/http.ts:64-75`.

Executado: `assertSafeUrl` aceitou `[::127.0.0.1]` (IPv4-compatível), `[2002:7f00:1::]` e `[2002:a00:1::1]`
(6to4), `[2001:0:7f00:1::1]` (Teredo), `[fec0::1]` (site-local) e `[64:ff9b:1::a9fe:a9fe]` (NAT64 de uso
local, que em rede com esse prefixo leva ao serviço de metadados). Não confirmado: se esses endereços
alcançam algo depende da rede de implantação, e o ambiente da revisão não tem IPv6.

**Correção.** Acrescentar `::/96`, `64:ff9b:1::/48`, `2001::/32`, `2002::/16` e `fec0::/10` à lista.

### 13. Senha temporária sem validade e troca de senha sem limite de tentativas — BAIXA — SUSPEITA

**Onde:** `apps/api/src/security/password.ts:47-53` e `:60-69`; `apps/api/src/modules/auth/routes.ts:286`
(sem `rateLimit`); `packages/core/src/settings/schema.ts:49`.

Senha temporária (criação e redefinição) vale indefinidamente até o primeiro uso; ela passa pelo
administrador e por canal fora do produto. `POST /auth/password` confere a senha atual sem limite e sem contar
para o bloqueio: quem tem uma sessão roubada testa senhas à vontade. A política aceita mínimo de 8 caracteres
e não recusa senhas comuns (`Senha12345` passa).

**Correção.** Validade para senha temporária (por exemplo, 72 h). Limite e contagem de falhas em
`/auth/password`. Lista de senhas comuns em `passwordProblem`.

### 14. `/metrics` aberto por padrão em produção — BAIXA — SUSPEITA

**Onde:** `apps/api/src/app.ts:183-192`; `apps/api/src/config/env.ts:74`.

Sem `METRICS_TOKEN`, que é opcional também em produção, `/metrics` responde sem autenticação: volume de logins
por resultado, rotas e latências, fila, memória do processo. Não há dado de empresa. Serve para acompanhar o
efeito dos achados 2, 4 e 5.

**Correção.** Em produção, exigir `METRICS_TOKEN` ou servir as métricas em porta interna separada.

---

## Verificado e considerado adequado

**Isolamento entre empresas**

- As 28 tabelas com `tenant_id`, mais `tenants` e `plans`, têm RLS ligada e ao menos uma política (conferido
  no catálogo). O papel da aplicação não é dono, não cria objetos em `public`, não tem `BYPASSRLS`, e a API
  recusa subir se tiver.
- Sondagens com o papel da aplicação no contexto da empresa A: zero linhas da empresa B em 12 tabelas;
  inserir conta, auditoria, trabalho ou usuário em B foi recusado (42501); alterar a própria licença não
  afetou linha alguma; mudar o próprio `slug` foi recusado; lote apontando para conta de B falhou na chave
  estrangeira composta (23503).
- Funções `SECURITY DEFINER`: todas com `search_path = public, pg_temp`, do papel dono, sem `EXECUTE` para
  `PUBLIC`. Devolvem o mínimo: sessão ou token pelo hash, usuário pelo e-mail no login, só ids de empresa na
  manutenção, só contagens nas métricas. `jobs_claim` devolve trabalhos de todas as empresas apenas ao
  trabalhador, que executa cada um em `withContext` da empresa dona.
- Todo `pool.query` fora de `withContext` em `apps/api/src` (12 ocorrências) chama uma dessas funções, o
  catálogo, `schema_migrations` ou `SELECT 1`. Nenhum toca tabela de empresa.
- Rotas de plataforma exigem `is_platform_admin`; operador não entra em rota de empresa. Token de API só vale
  nas duas rotas de entrada, exige escopo e módulo, e roda no contexto da empresa do token.
- Comandos de `src/ops/` usam o papel dono com filtro por `tenant_id` lido do banco, nomes escapados e
  literal de uuid validado. A exportação omite hashes, textos cifrados e sessões, e cria o arquivo com modo
  0600 sem sobrescrever. A eliminação exige empresa arquivada e confirmação do slug, e reabilita os gatilhos
  na mesma transação.

**Autenticação e autorização**

- As 124 rotas declaram autenticação e permissão. As de sessão com permissão nula são da própria conta,
  avisos do próprio usuário (filtrados por `user_id`) e leituras de cadastro; as de plataforma exigem o
  operador e as de token exigem escopo. Nenhuma escrita em dados da empresa está sem permissão.
- Sessão: token de 256 bits, só o hash no banco, cookie `HttpOnly` e `SameSite=Lax`, expiração absoluta e por
  inatividade, revogação ao desativar o usuário, redefinir ou trocar a senha. Permissões são lidas do banco a
  cada requisição.
- CSRF: exigido em todo método diferente de GET, com comparação em tempo constante; nenhuma rota GET altera
  dados de negócio.
- Senhas com scrypt e sal por senha; o login gasta o mesmo tempo para e-mail inexistente e só revela bloqueio
  ou conta desativada a quem acerta a senha.
- Módulos e limites do plano são conferidos no servidor; licença inativa bloqueia escritas.

**Segredos**

- AES-256-GCM com IV aleatório e dados autenticados `empresa:integração`. Nenhuma resposta devolve segredo,
  hash de senha ou hash de token. Mensagens de erro de serviços externos passam por `scrubSecret` e limite de
  tamanho. O token de API aparece uma vez, na criação.

**Saída para terceiros**

- `safeFetch`: só HTTPS, resolve o nome, recusa se qualquer endereço resolvido for proibido e conecta no
  endereço conferido (sem nova resolução). Executado: recusou `127.0.0.1`, `2130706433`, `0x7f.1`,
  `0177.0.0.1`, `127.1`, `[::1]`, `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `localhost`, `0.0.0.0`,
  `169.254.169.254` e as formas mapeadas de metadados, mesmo no modo de desenvolvimento. Não seguiu um 302
  para endereço interno (zero acessos ao destino) e interrompeu resposta acima do limite. Há tempo limite
  total. SMTP usa a mesma resolução.
- IA: saem só descrição normalizada, sentido e tipo, com referências locais. A resposta é validada por
  esquema e descartada inteira se citar referência desconhecida. Nunca confirma: grava sugestão de origem `ai`.

**Arquivos e exportação**

- Formato decidido pelo conteúdo. Nome de arquivo reduzido ao nome base e saneado no `Content-Disposition`;
  download sempre como anexo, com `nosniff`. Fórmulas não são avaliadas na leitura.
- Exportação CSV e XLSX: células de texto iniciadas por `=`, `+`, `-`, `@`, tabulação ou CR recebem apóstrofo;
  campos com `;`, aspas ou quebra de linha são citados; rótulos de coluna são fixos. Há teto de linhas.
- Nenhuma expressão regular é montada com texto do usuário. Colunas de SQL dinâmico vêm de esquemas Zod, que
  descartam chaves desconhecidas.

**Regras financeiras**

- Registros de origem: o gatilho recusa `UPDATE` nas colunas originais e qualquer `DELETE`; o papel da
  aplicação não tem `DELETE` nem `TRUNCATE` nessas tabelas nem na auditoria.
- Decisões: travas por item em ordem fixa e índice único de item ativo impedem duas conciliações vigentes
  para o mesmo item, inclusive contra o motor. Aceite em lote recusa ambíguas e divergentes. Diferença de
  valor exige observação e segue para aprovação. Proposta pendente continua exigindo aprovação mesmo com o
  módulo desligado depois. Par rejeitado ou desfeito não volta a ser conciliado sozinho.
- O motor nunca confirma por pontuação, só pelas regras; a ressalva é o achado 1.

**Interface web.** Sem `dangerouslySetInnerHTML`, sem armazenamento local de credenciais; links de avisos vêm
do servidor e passam pelo roteador.

## Fora do alcance desta revisão

Vulnerabilidades conhecidas das dependências, imagem Docker e scripts de backup, testes de carga, e
comportamento em rede com IPv6 (indisponível no ambiente).
