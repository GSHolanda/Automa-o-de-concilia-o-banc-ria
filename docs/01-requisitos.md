# 01 — Requisitos e critérios de aceitação

Produto: **Concilia** — plataforma de conciliação bancária multiempresa (nome comercial configurável por implantação).

Este documento define o que o produto-base deve fazer e como cada requisito é verificado. A coluna "Verificação" aponta para o tipo de teste automatizado; o mapeamento final para arquivos de teste e resultados está em `10-testes-e-resultados.md`.

## 1. Escopo

**Dentro do escopo (MVP executável):**

- Importação de extratos bancários (OFX, CSV, XLSX) e de lançamentos do sistema financeiro (CSV, XLSX ou API autenticada por token).
- Normalização, prevenção de duplicidade, classificação determinística (tarifas, estornos, transferências internas).
- Conciliação determinística com tolerâncias configuráveis e sugestões pontuadas para revisão humana.
- Painel, filtros, pesquisa, revisão, aprovação e desfazimento com trilha de auditoria.
- Exportação em CSV, XLSX e PDF.
- Multiempresa com isolamento lógico (tenant_id + Row-Level Security), papéis e permissões, sessões.
- Painel administrativo de configuração por empresa e assistente de onboarding.
- Módulos habilitáveis por empresa e base para licenciamento.

**Fora do escopo (explicitamente):**

- Conexão direta com bancos (Open Finance, APIs bancárias, robôs de internet banking). O produto **não** se conecta a bancos nem armazena credenciais bancárias.
- Escrita no ERP/sistema financeiro de origem. O produto gera arquivos e relatórios; não altera sistemas externos.
- Cobrança e meios de pagamento. Existe apenas a base de planos/licenças, sem provedor.
- Contabilização (geração de lançamentos contábeis oficiais, SPED).

## 2. Perfis de usuário

| Perfil | Descrição |
|---|---|
| Operador da plataforma | Equipe do fornecedor do SaaS. Cria empresas, define plano/licença e módulos. **Não** acessa dados financeiros das empresas. |
| Administrador da empresa | Configura a empresa, usuários, regras, integrações. |
| Gestor (aprovador) | Aprova conciliações que exigem segunda aprovação, desfaz conciliações. |
| Analista | Importa arquivos, executa conciliação, revisa sugestões, propõe conciliações manuais. |
| Auditor | Somente leitura: painéis, itens, exportações e trilha de auditoria. |

Os papéis acima são os padrões criados para cada empresa; papéis adicionais podem ser definidos por empresa a partir do catálogo de permissões.

## 3. Requisitos funcionais

### RF-01 Importação de extratos bancários

- RF-01.1 Aceitar OFX 1.x (SGML) e 2.x (XML), incluindo particularidades de bancos brasileiros: codificação Windows-1252, tags sem fechamento, datas com fuso (`[-3:BRT]`), valores com vírgula decimal.
- RF-01.2 Aceitar CSV (delimitador `;`, `,`, tabulação ou `|`; UTF-8 ou Windows-1252) e XLSX, com mapeamento de colunas definido em perfil de importação.
- RF-01.3 Pré-visualização antes de confirmar: cabeçalhos, primeiras linhas e mapeamento sugerido por heurística.
- RF-01.4 O arquivo original é preservado com hash SHA-256 como evidência.
- RF-01.5 Linhas inválidas são rejeitadas individualmente com motivo; não impedem as demais.
- RF-01.6 Em OFX, a conta do arquivo é comparada à conta bancária selecionada; divergência bloqueia a importação, salvo confirmação explícita.

### RF-02 Importação de lançamentos do sistema financeiro

- RF-02.1 CSV e XLSX com perfil de mapeamento (mesmas regras de RF-01.2).
- RF-02.2 API autenticada por token da empresa (`POST /api/v1/integrations/ledger/entries`), com chave de idempotência.
- RF-02.3 Um identificador de origem já existente com conteúdo diferente **não** sobrescreve o registro; gera conflito para revisão.

### RF-03 Normalização

- RF-03.1 Datas: `DD/MM/AAAA`, `DD/MM/AA`, `AAAA-MM-DD`, formato OFX, datas nativas de planilha. Armazenadas como data civil (sem fuso).
- RF-03.2 Valores: formatos brasileiro (`1.234,56`) e internacional (`1,234.56`), negativos por sinal, parênteses, sufixo `D`/`C`, colunas separadas de débito/crédito, coluna indicadora de tipo. Armazenados em centavos inteiros.
- RF-03.3 Sinal: entrada de recursos positiva, saída negativa, em ambos os lados.
- RF-03.4 Descrições: versão normalizada (maiúsculas, sem acentos, espaços colapsados) usada para comparação; a original é preservada.
- RF-03.5 Identificadores: normalizados (sem zeros à esquerda e sem pontuação) e extraídos da descrição quando reconhecíveis (documento, nosso número, NF, identificador de PIX).

### RF-04 Conciliação determinística

- RF-04.1 Regras aplicadas em ordem fixa e documentada: identificador + valor; valor + data + referência; valor + data com candidato único; tolerância de valor.
- RF-04.2 Tolerâncias configuráveis por empresa: dias de diferença de data, diferença de valor em centavos e percentual.
- RF-04.3 Só há conciliação automática quando a correspondência é única dos dois lados conforme a regra. Toda conciliação automática registra a regra aplicada e a versão do motor.
- RF-04.4 A mesma entrada com as mesmas regras produz sempre o mesmo resultado.

### RF-05 Sugestões com pontuação de confiança

- RF-05.1 Casos com mais de um candidato, diferença de valor, ou agrupamento (N:1, 1:N) geram **sugestões**, nunca conciliação automática.
- RF-05.2 Cada sugestão exibe confiança (0–100%) e a decomposição da pontuação (valor, data, identificador, descrição, concorrentes).
- RF-05.3 Sugestões rejeitadas não são propostas novamente para o mesmo par.

### RF-06 Duplicidade, tarifas, estornos e transferências internas

- RF-06.1 Reimportar o mesmo arquivo é bloqueado (hash do arquivo). Reimportar período sobreposto não duplica transações (chave de deduplicação por transação).
- RF-06.2 Transação semelhante a outra já existente, mas com identificador diferente, é importada e sinalizada como **possível duplicidade** para decisão humana.
- RF-06.3 Tarifas, impostos e juros bancários são identificados por regras de classificação configuráveis e propostos como "classificação sem lançamento correspondente".
- RF-06.4 Estornos são pareados com a transação original (mesmo valor absoluto, sinal oposto, janela configurável) como sugestão.
- RF-06.5 Transferências entre contas da mesma empresa são pareadas (débito em uma conta, crédito em outra) como sugestão ou automaticamente, conforme configuração.

### RF-07 Painel

- RF-07.1 Totais e valores de conciliados, pendentes e divergentes por conta bancária e período, para extrato e lançamentos.
- RF-07.2 Sugestões aguardando revisão e aprovações pendentes.
- RF-07.3 Última importação e última execução de conciliação.

### RF-08 Filtros, pesquisa, revisão e aprovação humana

- RF-08.1 Filtros por conta, período, situação, tipo, faixa de valor e texto livre (descrição, documento, identificador).
- RF-08.2 Ações: aceitar sugestão, rejeitar sugestão, conciliar manualmente (1:1, 1:N, N:1), classificar tarifa, ignorar item com justificativa, desfazer conciliação com justificativa.
- RF-08.3 Aprovação em duas etapas configurável (quem propõe não aprova), por tipo de operação e por valor de diferença.
- RF-08.4 Registros originais (data, valor, descrição, identificadores, linha bruta) são imutáveis. Toda decisão é registrada em entidades separadas.

### RF-09 Exportação

- RF-09.1 CSV (UTF-8 com BOM, `;`), XLSX e PDF dos itens filtrados e do relatório de conciliação.
- RF-09.2 Modelos de relatório configuráveis por empresa (título, colunas, rodapé).
- RF-09.3 Toda exportação é registrada na trilha de auditoria.

### RF-10 Autenticação, permissões e auditoria

- RF-10.1 Login por e-mail e senha; senhas com hash scrypt; bloqueio temporário após falhas sucessivas.
- RF-10.2 Sessões no servidor, revogáveis, com expiração por inatividade e absoluta; listagem e encerramento de sessões.
- RF-10.3 Permissões por papel; toda rota declara a permissão exigida.
- RF-10.4 Trilha de auditoria somente-inserção, encadeada por hash, com verificação de integridade.

### RF-11 Multiempresa

- RF-11.1 Toda entidade de negócio possui `tenant_id`; políticas RLS no PostgreSQL restringem leitura e escrita à empresa do contexto.
- RF-11.2 A aplicação conecta-se com papel de banco sem privilégio de ignorar RLS; a inicialização falha se o papel tiver esse privilégio.
- RF-11.3 Chaves estrangeiras compostas `(tenant_id, id)` impedem referências entre empresas.
- RF-11.4 A mesma base de código funciona em implantação compartilhada (várias empresas) ou dedicada (uma empresa por instalação).

### RF-12 Painel administrativo por empresa

Configurável sem alteração de código:

- RF-12.1 Nome da empresa e identidade visual (cor principal, logotipo).
- RF-12.2 Unidades, departamentos e centros de custo.
- RF-12.3 Plano de contas e categorias.
- RF-12.4 Regras de automação, tolerâncias e aprovações.
- RF-12.5 Usuários e papéis.
- RF-12.6 Perfis de importação (formato e mapeamento de colunas).
- RF-12.7 Integrações e credenciais (armazenadas cifradas; nunca devolvidas pela API).
- RF-12.8 Notificações e modelos de relatório.

### RF-13 Reutilização comercial

- RF-13.1 Assistente de onboarding com etapas persistidas.
- RF-13.2 Módulos obrigatórios e opcionais; habilitação por empresa.
- RF-13.3 Planos e licenças (situação, validade, limites) sem provedor de pagamento.
- RF-13.4 Migrações versionadas, somente para frente, com verificação de checksum.

### RF-14 Automação e processamento

- RF-14.1 Importação e conciliação executam em fila, com tentativas, espera progressiva e estado final "morto" visível.
- RF-14.2 Reprocessar um trabalho não duplica efeitos (idempotência).
- RF-14.3 Integrações externas só são marcadas como verificadas após chamada real bem-sucedida. Falhas são registradas com o erro.
- RF-14.4 IA é opcional, restrita a sugestões (classificação, mapeamento de colunas), sempre sujeita a aceite humano e identificada como tal.

## 4. Requisitos não funcionais

| ID | Requisito |
|---|---|
| RNF-01 | Interface responsiva em português do Brasil (uso em telas a partir de 360 px). |
| RNF-02 | Valores monetários em centavos inteiros; nenhuma aritmética de ponto flutuante em decisões. |
| RNF-03 | Segredos de integração cifrados com AES-256-GCM, vinculados à empresa; chave mestra fora do banco. |
| RNF-04 | Logs estruturados sem dados financeiros nem segredos; identificador de requisição em toda entrada. |
| RNF-05 | Métricas em formato Prometheus, verificações de vida e prontidão. |
| RNF-06 | LGPD: minimização, controle de acesso, retenção configurável de arquivos originais, exportação e eliminação por empresa. |
| RNF-07 | Testes automatizados: unitários, integração (banco real), ponta a ponta e isolamento entre empresas. Nenhum dado real em testes ou demonstração. |
| RNF-08 | Contratos de API versionados (`/api/v1`) com especificação OpenAPI gerada do código. |

## 5. Critérios de aceitação

| ID | Critério | Requisitos | Verificação |
|---|---|---|---|
| CA-01 | Um OFX de banco brasileiro em Windows-1252, sem tags de fechamento, é importado com datas, valores e sinais corretos. | RF-01.1, RF-03 | Unitário + integração |
| CA-02 | CSV com `;` e valores `1.234,56`, com colunas débito/crédito separadas, é importado conforme o perfil. | RF-01.2, RF-03.2 | Unitário + integração |
| CA-03 | XLSX com datas nativas e valores numéricos é importado conforme o perfil. | RF-01.2 | Unitário + integração |
| CA-04 | Reenviar o mesmo arquivo retorna erro de duplicidade; arquivo com período sobreposto importa apenas as transações novas. | RF-06.1 | Integração |
| CA-05 | Linha com data inválida é rejeitada com motivo, e as demais linhas são importadas. | RF-01.5 | Integração |
| CA-06 | Par com mesmo identificador e mesmo valor, único dos dois lados, é conciliado automaticamente com a regra registrada. | RF-04 | Unitário + integração |
| CA-07 | Dois lançamentos de mesmo valor e data para uma transação bancária geram duas sugestões e nenhuma conciliação automática. | RF-05.1 | Unitário + integração |
| CA-08 | Mesmo identificador com valor diferente gera divergência, não conciliação. | RF-04, RF-07 | Unitário + integração |
| CA-09 | Tarifa bancária reconhecida por regra aparece como sugestão de classificação. | RF-06.3 | Unitário + integração |
| CA-10 | Débito e crédito de mesmo valor em duas contas da empresa são propostos como transferência interna. | RF-06.5 | Unitário + integração |
| CA-11 | Estorno é pareado com a transação original como sugestão. | RF-06.4 | Unitário |
| CA-12 | Com aprovação em duas etapas ativa, o analista que propôs não consegue aprovar; outro usuário com permissão consegue. | RF-08.3 | Integração |
| CA-13 | Tentativa de `UPDATE` em coluna original de transação é rejeitada pelo banco. | RF-08.4 | Integração (banco) |
| CA-14 | Desfazer conciliação exige justificativa, devolve os itens a pendente e gera registro de auditoria. | RF-08.2, RF-10.4 | Integração |
| CA-15 | Usuário da empresa A não lê nem altera qualquer recurso da empresa B por nenhuma rota; retorno é 404. | RF-11 | Integração (isolamento) |
| CA-16 | Consulta SQL com o papel da aplicação e contexto da empresa A não retorna linhas da empresa B; sem contexto, não retorna linha alguma. | RF-11.1 | Integração (banco) |
| CA-17 | `UPDATE`/`DELETE` na trilha de auditoria é rejeitado; adulteração simulada por superusuário é detectada pela verificação da cadeia. | RF-10.4 | Integração (banco) |
| CA-18 | Usuário sem a permissão exigida recebe 403; usuário não autenticado recebe 401. | RF-10.3 | Integração |
| CA-19 | Sessão revogada deixa de autenticar imediatamente. | RF-10.2 | Integração |
| CA-20 | Exportações CSV, XLSX e PDF são geradas, reabertas por leitor e contêm os itens filtrados. | RF-09 | Integração |
| CA-21 | Alterar tolerância de data pela configuração muda o resultado da conciliação seguinte sem alterar código. | RF-12.4 | Integração |
| CA-22 | Trabalho que falha é repetido até o limite e termina como "morto" com o erro registrado; reprocessar um trabalho concluído não duplica dados. | RF-14.1, RF-14.2 | Integração |
| CA-23 | Segredo de integração nunca aparece em resposta da API, log ou auditoria; o texto cifrado de uma empresa não decifra no contexto de outra. | RNF-03 | Unitário + integração |
| CA-24 | Módulo desabilitado para a empresa bloqueia as rotas do módulo. | RF-13.2 | Integração |
| CA-25 | Licença suspensa bloqueia operações de escrita e mantém leitura e exportação. | RF-13.3 | Integração |
| CA-26 | Fluxo completo no navegador: login, onboarding, importação, conciliação, revisão e exportação. | Geral | Ponta a ponta |
| CA-27 | Integração externa não alcançada fica com situação de erro e mensagem; nunca "verificada". | RF-14.3 | Integração |
| CA-28 | Migrações aplicadas duas vezes não alteram o banco; checksum divergente interrompe a execução. | RF-13.4 | Integração |
