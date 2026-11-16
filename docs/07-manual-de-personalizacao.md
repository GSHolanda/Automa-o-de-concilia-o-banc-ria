# Manual de personalização

Este manual explica como adaptar o Concilia a uma empresa nova **sem alterar código**. Ele é para a equipe de implantação do fornecedor e para o administrador da empresa cliente.

Princípio do produto: **o que muda de uma empresa para outra fica no banco de dados e se configura pela interface.** O que muda de uma instalação para outra fica em variáveis de ambiente do servidor. A seção 13 separa os dois casos, e a seção 14 lista com honestidade o que hoje não é configurável.

O uso do dia a dia (importar, conciliar, aprovar) está no `06-manual-do-administrador.md`. Nomes de menus e botões aparecem aqui como na tela.

## Sumário

1. Roteiro de implantação de um cliente
2. Lista de verificação
3. Identidade visual e dados da empresa
4. Unidades, departamentos e centros de custo
5. Plano de contas e categorias (e modelos)
6. Contas bancárias
7. Regras e tolerâncias da conciliação
8. Aprovações
9. Regras de classificação
10. Perfis de importação
11. Papéis personalizados
12. Módulos, planos e limites de licença; integrações e notificações; modelos de relatório; retenção e segurança
13. O que é por empresa e o que é por instalação
14. O que não é configurável hoje

---

## 1. Roteiro de implantação de um cliente

Há dois atores: o **operador da plataforma** (equipe do fornecedor) e o **administrador da empresa** (cliente).

### 1.1 O operador cria a empresa e define o plano

O operador entra no Concilia com a conta de operador (criada na instalação, pelo comando `platform:create-admin`). No menu aparece **Empresas**.

1. Clique em **Empresas** e depois em **Nova empresa**.
2. Preencha:
   - **Identificador**: letras minúsculas, números e hífen (até 50 caracteres).
   - **Razão social** e **Nome fantasia**.
   - **CNPJ/CPF** (opcional; só os dígitos são gravados).
   - **Plano**: Essencial, Profissional ou Corporativo (seção 12.1).
   - **Nome do administrador** e **E-mail do administrador**.
3. Salve. Aparece "Empresa criada." e, **uma única vez**, a senha temporária do administrador (título "Administrador de ..."). Copie e entregue ao administrador por um canal seguro.
4. Se necessário, em **Licença** (na linha da empresa) ajuste **Situação**, **Validade** e os **Limites** que substituem os do plano (seção 12.2). A licença nasce como **Avaliação**.

A empresa nasce na situação **Implantação**. Já vem com: os quatro papéis padrão, as configurações padrão, 4 categorias (Tarifas bancárias, Impostos sobre operações financeiras, Juros e encargos, Transferências entre contas), 23 regras de classificação com o vocabulário usual de extratos brasileiros e 2 modelos de relatório (**Itens — padrão** e **Resumo — padrão**). Dos módulos opcionais do plano, só **Transferências internas** e **Agrupamento** vêm ligados; os demais o administrador liga em **Configurações > Módulos**.

(O mesmo pode ser feito pela linha de comando: `pnpm cli tenant:create ...`. Veja `pnpm cli help`.)

### 1.2 O administrador conclui o assistente de implantação

1. O administrador entra, troca a senha temporária (manual do administrador, seção 2) e vê a faixa "A implantação da empresa ainda não foi concluída."
2. Clica em **Continuar a implantação** (ou em **Implantação** no menu).
3. A tela mostra "N de 8 etapas concluídas" e uma barra de progresso. As etapas, em ordem, e o que cada **botão** abre:

| # | Etapa | Obrigatória | Botão que abre a tela |
|---|---|:-:|---|
| 1 | Dados da empresa | **Sim** | **Abrir dados da empresa** |
| 2 | Identidade visual | Não | **Abrir identidade visual** |
| 3 | Contas bancárias | **Sim** (ao menos uma ativa) | **Abrir contas bancárias** |
| 4 | Unidades e centros de custo | Não | **Abrir estrutura** |
| 5 | Plano de contas e categorias | Não | **Abrir plano de contas** (e **Aplicar plano de contas modelo**) |
| 6 | Perfil de importação | Não | **Abrir perfis de importação** |
| 7 | Regras de classificação | Não | **Abrir regras de classificação** |
| 8 | Usuários | Não | **Abrir usuários** |

4. Uma etapa é marcada como **Concluída** automaticamente quando já há dados cadastrados (por exemplo, uma conta bancária ativa). Também é possível usar **Marcar como concluída** ou **Marcar como pendente** manualmente.
5. Quando as etapas obrigatórias estiverem prontas, clique em **Concluir implantação**. Aparece "Implantação concluída. A empresa está ativa." e a faixa de aviso some. Se faltar algo, a tela lista "Ainda falta concluir:".

Concluir a implantação exige apenas os **dados da empresa** e **ao menos uma conta bancária ativa**. As demais etapas são recomendadas.

Quem conclui precisa da permissão "Alterar configurações e cadastros" (o Administrador a tem).

## 2. Lista de verificação

Use esta lista na entrega ao cliente. Marque cada item.

**Cadastro**
- [ ] Empresa criada com o plano correto, e licença com **Situação** e **Validade** corretas.
- [ ] Administrador entrou e trocou a senha temporária.
- [ ] **Empresa**: razão social, nome fantasia e CNPJ conferidos.
- [ ] **Identidade visual**: cor e logotipo aplicados.
- [ ] **Contas bancárias**: todas cadastradas, com **Número da conta** correto (é ele que permite o aviso de conta divergente em arquivos OFX), além de **Código do banco** e **Agência**.
- [ ] **Estrutura**, **Plano de contas** e **Categorias** conforme o cliente.
- [ ] **Perfis de importação** criados e testados com um arquivo real do cliente (fora do ambiente de produção, se houver dado sensível).
- [ ] **Classificação**: regras revisadas com o vocabulário dos bancos do cliente.

**Regras**
- [ ] **Regras e tolerâncias** revisadas com o responsável financeiro (principalmente a **Tolerância de data** e as caixas de conciliação automática).
- [ ] **Aprovações**: decidido se o módulo será usado, e quais operações exigem segunda pessoa.
- [ ] **Módulos**: ligados apenas os que o plano inclui e o cliente vai usar.

**Pessoas**
- [ ] Usuários criados, cada um com o papel adequado. Pelo menos um Gestor, se houver aprovação.
- [ ] Papéis personalizados criados, se necessário.
- [ ] **Segurança**: inatividade da sessão e tamanho mínimo de senha definidos.

**Integrações (se contratadas)**
- [ ] Cada integração com **Testar conexão** bem-sucedido (situação **Verificada**).
- [ ] **Notificações**: regras criadas e uma entrega de teste conferida.
- [ ] **Tokens de API** criados e entregues à equipe do sistema financeiro, com a validade combinada.

**Teste final**
- [ ] Importar um extrato e os lançamentos do mesmo período, executar a conciliação e conferir os números no **Painel**.
- [ ] **Auditoria**: **Verificar integridade** mostra **Cadeia íntegra**.
- [ ] **Implantação concluída** e a empresa na situação **Ativa**.
- [ ] Instalação: backup agendado e variáveis de ambiente de produção conferidas (`05-instalacao-e-atualizacao.md` e `08-operacao-backup-recuperacao.md`).

Dados de teste e demonstração devem ser sempre fictícios.

---

## 3. Identidade visual e dados da empresa

**Configurações > Empresa**: **Razão social**, **Nome fantasia** e **CNPJ** (aceita CPF; a pontuação é opcional). O nome fantasia aparece na barra superior e nos relatórios.

**Configurações > Identidade visual** ("Cor principal e logotipo, aplicados a toda a interface da empresa"):

1. Em **Cor principal**, escolha no seletor ou digite o código no formato `#RRGGBB`. Padrão: `#0b5cab`.
2. Clique em **Selecionar logotipo** (ou **Trocar logotipo**). Formatos: PNG, JPEG ou WebP, **até 200 KB**. SVG não é aceito, por segurança.
3. Salve.

O logotipo substitui o nome do produto no menu lateral.

O nome do produto exibido quando não há logotipo ("Concilia") é definido por instalação (`PRODUCT_NAME`), não por empresa.

## 4. Unidades, departamentos e centros de custo

**Configurações > Estrutura** tem três abas: **Unidades**, **Departamentos** e **Centros de custo**. Em cada uma:

1. Clique em **Nova unidade** (ou **Novo departamento**, **Novo centro de custo**).
2. Preencha **Código** (até 40 caracteres), **Nome** (até 120) e, se quiser hierarquia, **Superior** (padrão "Nenhum (nível raiz)").
3. Mantenha **Ativo** marcado e salve.

Cada linha tem **Editar**, **Desativar**/**Ativar** e **Excluir**. A **Unidade** pode ser vinculada a uma conta bancária (seção 6). O centro de custo também pode vir nos arquivos importados (coluna **Centro de custo** do perfil).

## 5. Plano de contas e categorias

### 5.1 Telas

**Configurações > Plano de contas**: **Código**, **Nome**, **Tipo** (Ativo, Passivo, Patrimônio líquido, Receita, Despesa), **Conta superior** e **Ativa**.

**Configurações > Categorias**: **Código**, **Nome**, **Tipo** (Tarifa, Imposto, Juros e encargos, Transferência, Receita, Despesa, Outros), **Conta contábil** (uma conta do plano) e **Ativa**. As categorias são usadas para classificar tarifas, impostos, juros e demais itens, e nas regras de classificação.

### 5.2 Aplicar o modelo básico

O arquivo `config/templates/plano-de-contas-basico.json` traz um plano resumido e genérico (26 contas: Ativo, Passivo, Patrimônio líquido, Receitas e Despesas) e 11 categorias ligadas às contas (por exemplo TARIFA para a conta 5.4).

1. Em **Implantação**, na etapa "Plano de contas e categorias", clique em **Aplicar plano de contas modelo**.
2. Aparece "Plano de contas aplicado: N contas e N categorias criadas." Contas e categorias com o mesmo código que já existiam são **mantidas** (não duplicam nem sobrescrevem), e a tela informa quantas.
3. Ajuste depois em **Plano de contas** e **Categorias**.

### 5.3 Criar outros modelos

Um modelo é um arquivo `.json` na pasta `config/templates/` do servidor (ou na pasta indicada por `TEMPLATES_DIR`). O nome do arquivo (sem `.json`) é o nome do modelo: letras minúsculas, números e hífen (por exemplo `plano-de-contas-varejo.json`).

Estrutura:

```json
{
  "name": "Plano de contas do varejo",
  "description": "Texto livre (opcional)",
  "accounts": [
    { "code": "1", "name": "Ativo", "type": "asset", "parent": null },
    { "code": "1.1", "name": "Ativo circulante", "type": "asset", "parent": "1" }
  ],
  "categories": [
    { "code": "TARIFA", "name": "Tarifas bancárias", "kind": "fee", "account": "5.4" }
  ]
}
```

Regras:

- `accounts[].type`: `asset`, `liability`, `equity`, `revenue` ou `expense`.
- `categories[].kind`: `fee`, `tax`, `interest`, `transfer`, `revenue`, `expense` ou `other`.
- `parent` e `account` referem o `code` de uma conta. A conta superior **deve aparecer antes** dos filhos na lista. Caso contrário o modelo é recusado ("conta pai ... não encontrada").
- `code`: até 40 caracteres. `name`: até 160 (contas) e 120 (categorias).

**Limitação:** o botão **Aplicar plano de contas modelo** da tela aplica apenas o modelo `plano-de-contas-basico`. Para aplicar outro modelo, a equipe técnica usa a API (`POST /api/v1/onboarding/apply-template` com `{"template": "nome-do-arquivo"}`). Veja `04-api-e-conectores.md`.

## 6. Contas bancárias

**Configurações > Contas bancárias** ("Contas cujos extratos são conciliados"). Clique em **Nova conta bancária**:

| Campo | Observação |
|---|---|
| **Nome** | Obrigatório. É o que aparece nos filtros e relatórios. |
| **Código do banco** | Só dígitos, por exemplo 341. |
| **Banco** | Nome do banco. |
| **Agência** e **Número da conta** | O **Número da conta** é comparado com o do arquivo OFX (aviso de conta divergente). |
| **Moeda** | Três letras maiúsculas. Padrão BRL. |
| **Unidade** | Opcional, da **Estrutura**. |
| **Conta contábil** | Opcional, do **Plano de contas**. |
| **Referência externa** | Identificador da conta no sistema financeiro, se houver. |
| **Ativa** | O plano limita o número de contas **ativas**. |

## 7. Regras e tolerâncias da conciliação

Tela: **Configurações > Regras e tolerâncias**. Altere os valores e clique em **Salvar alterações**. Se outra pessoa alterou a configuração depois que você abriu a tela, o sistema avisa e pede para recarregar (suas edições não salvas são descartadas). As regras valem para as **próximas execuções** da conciliação.

A confirmação automática depende **só** destas regras. A "confiança" nunca confirma nada sozinha.

### 7.1 Tolerâncias e identificadores

| Campo na tela | O que faz | Padrão | Limites | Efeito de aumentar | Efeito de diminuir |
|---|---|---|---|---|---|
| **Tolerância de data** (dias) | Diferença máxima de datas entre extrato e lançamento nas regras de valor e data, no agrupamento e na tolerância de valor | 2 | 0 a 30 | Casa pagamentos lançados e compensados com mais folga (fim de semana, feriado), mas aumenta candidatos e ambiguidades | Exige datas mais próximas; menos falsos pares, mais itens pendentes. Com 0, só a mesma data |
| **Limite de dias para identificador** (dias) | Afastamento máximo de datas quando o identificador e o valor conferem | 10 | 0 a 120 | Concilia mais por identificador, mesmo com datas distantes (como boletos pagos com atraso) | Pares com identificador e datas além do limite viram sugestão com divergência de data, em vez de confirmação |
| **Tolerância de valor** (R$) | Diferença em reais aceita para **sugerir** (nunca concilia sozinho). Internamente em centavos, até R$ 10.000,00 | R$ 0,00 | 0 a 10.000,00 | Sugere pares com diferença maior (por exemplo, tarifa descontada do valor) | Com 0, só valores exatos |
| **Tolerância de valor percentual** (%) | Diferença proporcional aceita para sugerir. Vale a **maior** entre o valor em R$ e o percentual | 0 | 0 a 10 | Mesmo efeito, proporcional ao valor | Com 0, valores exatos |
| **Tamanho mínimo de identificador** (caracteres) | Identificadores mais curtos são ignorados | 4 | 3 a 20 | Evita casar documentos curtos e parecidos (por exemplo "NF 12"); perde identificadores curtos legítimos | Aceita identificadores curtos, com mais risco de pares errados |

(Se **Tolerância de valor** e **Tolerância de valor percentual** estiverem em 0, a regra "Valor dentro da tolerância" fica desligada.)

### 7.2 Conciliação automática

| Caixa | Padrão | O que confirma sozinho |
|---|:-:|---|
| **Por identificador** | Ligada | Identificador e valor iguais, datas dentro do limite, par único |
| **Por valor, data e descrição** | Ligada | Valor igual, **mesma data**, descrição parecida, par único |
| **Por candidato único** | Ligada | Valor igual e datas dentro da tolerância, só um candidato |
| **Transferências internas** | **Desligada** | Saída de uma conta e entrada correspondente em outra, quando os dois lados foram reconhecidos como transferência |
| **Tarifas** | **Desligada** | Tarifas, impostos e juros reconhecidos pelas regras de classificação, sem lançamento correspondente |

Desligar uma caixa não apaga a regra: o par passa a aparecer como **sugestão** para decisão humana. Empresas com muitos valores repetidos devem avaliar desligar **Por candidato único**. Ao começar com um cliente novo, é comum deixar também as caixas padrão ligadas e acompanhar os primeiros meses pela taxa do indicador **Conciliação automática** do painel.

### 7.3 Sugestões

| Campo | O que faz | Padrão | Limites | Aumentar | Diminuir |
|---|---|---|---|---|---|
| **Confiança mínima** (%) | Sugestões abaixo deste percentual não aparecem | 30 | 0 a 100 | Menos sugestões, mais certeiras; pode esconder pares válidos | Mais sugestões, inclusive fracas |
| **Máximo de sugestões por item** | Quantas opções mostrar por item | 3 | 1 a 10 | Mais alternativas em caso de ambiguidade | Menos ruído na tela |

### 7.4 Agrupamento (módulo Agrupamento)

| Campo | O que faz | Padrão | Limites | Aumentar | Diminuir |
|---|---|---|---|---|---|
| **Sugerir agrupamentos** | Liga a busca de um item igual à soma de vários | Ligado | liga/desliga | n/a | Desligado: nunca sugere somas |
| **Máximo de itens por grupo** | Quantos itens podem formar a soma | 4 | 2 a 6 | Encontra grupos maiores, mais lento e com mais coincidências | Só combinações pequenas |
| **Máximo de candidatos analisados** | Quantos lançamentos próximos entram na busca | 12 | 2 a 16 | Busca mais ampla e mais lenta | Mais rápida, pode perder combinações |

### 7.5 Transferências (módulo Transferências internas)

| Campo | O que faz | Padrão | Limites | Aumentar | Diminuir |
|---|---|---|---|---|---|
| **Detectar transferências entre contas** | Liga o pareamento de débito e crédito entre contas da empresa | Ligado | liga/desliga | n/a | Desligado: transferências ficam como itens comuns |
| **Tolerância de data da transferência** (dias) | Diferença de datas entre a saída e a entrada | 1 | 0 a 10 | Aceita transferências com compensação mais lenta | Exige a mesma data (0) ou quase |

### 7.6 Estornos

| Campo | O que faz | Padrão | Limites | Aumentar | Diminuir |
|---|---|---|---|---|---|
| **Detectar estornos** | Liga o pareamento de um movimento com seu estorno | Ligado | liga/desliga | n/a | Desligado: estornos ficam pendentes |
| **Janela de estorno** (dias) | Prazo máximo entre o movimento original e o estorno | 30 | 0 a 180 | Reconhece estornos tardios | Só estornos rápidos |

Os módulos **Agrupamento** e **Transferências internas** precisam estar ligados em **Módulos** para que as respectivas caixas tenham efeito. Em empresas do plano **Essencial**, só as transferências estão disponíveis.

## 8. Aprovações

**Configurações > Aprovações**, com o módulo **Aprovação em duas etapas** ativo. Os campos são os do manual do administrador (seção 8). Resumo dos padrões:

| Campo | Padrão |
|---|:-:|
| **Exigir aprovação em duas etapas** | Desligado |
| **Quem propõe não aprova** | Ligado |
| **Conciliação manual** | Ligado |
| **Conciliação com diferença de valor** | Ligado |
| **Itens com mais de uma possibilidade** | Desligado |
| **Conciliação em grupo** | Desligado |
| **Classificação de itens** | Desligado |
| **Ignorar itens** | Ligado |

Sem o módulo ativo, ou com **Exigir aprovação em duas etapas** desligado, toda decisão vale imediatamente. Quem aprova precisa de um papel com a permissão "Aprovar conciliações pendentes de aprovação" (Gestor ou Administrador, ou um papel personalizado).

## 9. Regras de classificação

**Configurações > Classificação**. Estas regras reconhecem pelo texto da descrição quando um item é tarifa, imposto, juros, estorno ou transferência. O motor usa essa informação (por exemplo, a regra "Estorno" e a regra "Transferência entre contas" dependem dela). As regras são aplicadas quando o arquivo é processado.

Clique em **Nova regra de classificação** e preencha:

| Campo | O que faz |
|---|---|
| **Nome** | Nome livre da regra. |
| **Prioridade** | Menor número é avaliado primeiro. Padrão 100. De 0 a 10.000. |
| **Tipo de comparação** | Como o texto é comparado (veja abaixo). |
| **Texto** | Palavra ou expressão. Comparado com a descrição **normalizada**: sem acentos, em maiúsculas e sem pontuação (por exemplo "MANUT. CONTA" vira "MANUT CONTA"). Maiúsculas e acentos que você digitar não importam. |
| **Lado** | **Extrato bancário**, **Lançamentos** ou **Ambos os lados**. |
| **Direção** | **Qualquer**, **Entrada (crédito)** ou **Saída (débito)**. |
| **Tipo resultante** | **Comum**, **Tarifa**, **Imposto**, **Juros e encargos**, **Estorno** ou **Transferência interna**. |
| **Categoria** | Opcional. Categoria atribuída ao item. |
| **Ativa** | Regra desativada não é avaliada. |

**Tipos de comparação** (sempre por palavra inteira, nunca por pedaço de palavra: "TAR" não casa com "GUITARRA"):

| Tipo | Casa quando... | Exemplo (Texto → descrição que casa) |
|---|---|---|
| **Contém a palavra** | A palavra ou expressão aparece em qualquer lugar | `TARIFA` → "DEB TARIFA PIX 03/01" |
| **Começa com** | A descrição começa exatamente com o texto | `IOF` → "IOF S/ OPERACAO" |
| **Igual a** | A descrição inteira é igual | `ANUIDADE` → "ANUIDADE" |
| **Contém todas as palavras** | Todas as palavras aparecem, em qualquer ordem | `PACOTE SERVICOS` → "SERVICOS PACOTE EMPRESA" |

**A primeira regra ativa que casar, por ordem de prioridade, vale.** Se duas regras têm a mesma prioridade, desempata o nome. Sem regra que case, o item é **Comum**. Coloque regras mais específicas com **prioridade menor** (por exemplo, "Estorno" antes de "Tarifa", para que "ESTORNO TARIFA" seja estorno e não tarifa; as regras iniciais já fazem isso: estornos 10, transferências 20, impostos 30, tarifas 40, juros 50).

**Exemplos para tarifas de bancos**

| Nome | Prioridade | Comparação | Texto | Lado | Direção | Tipo resultante | Categoria |
|---|---|---|---|---|---|---|---|
| Tarifa Pix | 40 | Contém a palavra | `TARIFA PIX` | Extrato bancário | Saída (débito) | Tarifa | Tarifas bancárias |
| Cesta de serviços | 40 | Contém todas as palavras | `CESTA SERVICOS` | Extrato bancário | Saída (débito) | Tarifa | Tarifas bancárias |
| Tarifa de TED | 41 | Contém todas as palavras | `TAR TED` | Extrato bancário | Saída (débito) | Tarifa | Tarifas bancárias |
| IOF | 30 | Começa com | `IOF` | Extrato bancário | Saída (débito) | Imposto | Impostos sobre operações financeiras |
| Juros de cheque especial | 50 | Contém a palavra | `JUROS` | Extrato bancário | Saída (débito) | Juros e encargos | Juros e encargos |
| Transferência entre contas | 20 | Contém todas as palavras | `TRANSF ENTRE CONTAS` | Extrato bancário | Qualquer | Transferência interna | Transferências entre contas |

Cada banco escreve as tarifas de um jeito. Olhe os extratos reais do cliente (com cuidado com dados pessoais), liste as expressões que se repetem e crie uma regra para cada uma. Depois de importar, a aba **Pendentes** mostra o que ainda não foi reconhecido.

Para as tarifas serem **confirmadas sozinhas**, ligue a caixa **Tarifas** em **Regras e tolerâncias**. Caso contrário elas aparecem como sugestão **Classificação por regra**.

## 10. Perfis de importação

Um perfil "ensina o sistema a ler o arquivo de cada banco ou sistema contábil: quais colunas são data, valor e descrição". Vale para **CSV** e **XLSX**. (OFX tem formato padronizado e não precisa de perfil.)

### 10.1 Como criar

**Pela tela de perfis:**

1. Abra **Configurações > Perfis de importação** e clique em **Novo perfil**.
2. Preencha **Nome do perfil** (por exemplo "Extrato Banco X (CSV)"), **Origem** (**Extrato bancário** ou **Lançamentos**) e **Formato do arquivo** (**CSV** ou **Planilha (XLSX)**).
3. Configure o mapeamento no editor (seção 10.2).
4. Deixe **Perfil ativo** marcado (perfis inativos não aparecem nas novas importações) e salve.

**Pela importação (mais prático):** em **Importações > Nova importação**, envie um arquivo real, ajuste o mapeamento no passo 2, marque **Salvar como perfil de importação** e informe o **Nome do perfil**. Nas próximas vezes, escolha-o em **Perfil de importação (opcional)**.

Na lista de perfis há **Editar** (ou **Ver**, sem permissão de alterar), **Desativar**/**Ativar** e **Excluir**.

### 10.2 Campos do mapeamento

| Bloco | Campo | O que fazer |
|---|---|---|
| Leitura do arquivo | **Delimitador** | **Automático**, **Ponto e vírgula (;)**, **Vírgula (,)**, **Tabulação** ou **Barra vertical (\|)**. Só CSV. Bancos brasileiros costumam usar ponto e vírgula. |
| | **Codificação** | **Automática**, **UTF-8** ou **Windows-1252**. Se os acentos saírem errados, use Windows-1252. Só CSV. |
| | **Aba da planilha** | Nome da aba. Vazio usa a primeira. Só XLSX. |
| | **Linha do cabeçalho** | Número da linha onde estão os nomes das colunas (de 0 a 200). **0** = arquivo sem cabeçalho; então indique colunas como `#1`, `#2`... |
| | **Formato de data** | **Automático**, **DD/MM/AAAA**, **MM/DD/AAAA**, **AAAA-MM-DD** ou **AAAAMMDD**. Prefira indicar o formato. |
| | **Separador decimal** | **Automático**, **Vírgula (1.234,56)** ou **Ponto (1,234.56)**. |
| Valor | **Como o valor aparece** | **Uma coluna, com sinal**; **Colunas de débito e crédito**; ou **Valor e coluna de tipo**. |
| | **Inverter o sinal** | Para arquivos que mostram saídas como positivas. |
| Colunas | **Data**, **Valor** (ou **Débito (saída)** e **Crédito (entrada)**, ou **Valor** + **Tipo (entrada/saída)**), **Descrição** (até 5 colunas, unidas) | Escolha pelo nome exato do cabeçalho ou por `#N` (posição, a partir de 1). |
| | Opcionais: **Identificador**, **Documento**, **Referência**, **Favorecido**, **Vencimento**, **Conta**, **Centro de custo**, **Categoria** | Preencha o que o arquivo tiver. O **Identificador** é o que mais ajuda. |
| Valores da coluna de tipo | **Indicam saída** e **Indicam entrada** | Só no modo "Valor e coluna de tipo". Separe por vírgula. Padrões: saída = D, DEBITO, SAIDA, PAGAR, PAGAMENTO, DESPESA, -; entrada = C, CREDITO, ENTRADA, RECEBER, RECEBIMENTO, RECEITA, +. Um valor não pode estar nos dois grupos. |
| Linhas a ignorar | **Textos de linhas a ignorar** | Um por linha (até 30 textos de até 80 caracteres). Linhas cuja descrição **começa** com um destes textos não viram transações. Padrões: SALDO ANTERIOR, SALDO DO DIA, SALDO DIA, SALDO FINAL, SALDO ATUAL, SALDO DISPONIVEL, SALDO BLOQUEADO, S A L D O. |

Regras do sistema: o valor sai do arquivo com o sinal correto (entrada positiva, saída negativa). Valores com mais de duas casas decimais são rejeitados. Cada nome de coluna é comparado sem diferenciar maiúsculas e acentos.

### 10.3 Exemplo 1: extrato CSV de banco, com débito e crédito em colunas separadas

Arquivo fictício, com linhas de título antes do cabeçalho:

```
Extrato da conta;Agencia 0001;Conta 12345-6
Periodo;01/01/2024 a 31/01/2024
Data;Historico;Documento;Debito;Credito;Saldo
02/01/2024;SALDO ANTERIOR;;;;12.500,00
03/01/2024;PIX RECEBIDO CLIENTE ALFA;000123;;1.500,00;14.000,00
05/01/2024;TARIFA PIX;;7,50;;13.992,50
```

Perfil:

| Campo | Valor |
|---|---|
| Nome do perfil | Extrato Banco Exemplo (CSV) |
| Origem / Formato | Extrato bancário / CSV |
| Delimitador | Ponto e vírgula (;) |
| Codificação | Windows-1252 |
| Linha do cabeçalho | 3 |
| Formato de data | DD/MM/AAAA |
| Separador decimal | Vírgula (1.234,56) |
| Como o valor aparece | Colunas de débito e crédito |
| Inverter o sinal | Desmarcado |
| Data | `Data` |
| Débito (saída) | `Debito` |
| Crédito (entrada) | `Credito` |
| Descrição (coluna 1) | `Historico` |
| Documento | `Documento` |
| Textos de linhas a ignorar | os padrões (a linha SALDO ANTERIOR é ignorada) |

A coluna `Saldo` não é usada. As linhas de título (1 e 2) ficam acima do cabeçalho e são desconsideradas.

### 10.4 Exemplo 2: planilha XLSX de lançamentos, com valor e coluna de tipo

Planilha fictícia na aba "Contas":

| Vencimento | Emissao | Fornecedor/Cliente | NF | Valor | Tipo | ID |
|---|---|---|---|---|---|---|
| 10/01/2024 | 02/01/2024 | Cliente Alfa | 000123 | 1500,00 | Receber | L-0001 |
| 12/01/2024 | 03/01/2024 | Fornecedor Beta | 000456 | 820,00 | Pagar | L-0002 |

Perfil:

| Campo | Valor |
|---|---|
| Nome do perfil | Lançamentos ERP (XLSX) |
| Origem / Formato | Lançamentos / Planilha (XLSX) |
| Aba da planilha | `Contas` |
| Linha do cabeçalho | 1 |
| Formato de data | DD/MM/AAAA |
| Como o valor aparece | Valor e coluna de tipo |
| Data | `Emissao` |
| Valor | `Valor` |
| Tipo (entrada/saída) | `Tipo` |
| Indicam saída | PAGAR, PAGAMENTO, DESPESA |
| Indicam entrada | RECEBER, RECEBIMENTO, RECEITA |
| Descrição (coluna 1 e 2) | `Fornecedor/Cliente` e `NF` |
| Identificador | `ID` |
| Documento | `NF` |
| Vencimento | `Vencimento` |

Aqui "Receber" vira entrada positiva e "Pagar" vira saída negativa, mesmo com o valor sem sinal na planilha.

**Dicas:** teste o perfil com um arquivo pequeno antes do arquivo cheio. A pré-visualização mostra as primeiras linhas, e o passo 2 permite corrigir sem importar. Se o banco mudar o layout, edite o perfil. Qualquer perfil muda só para a empresa em que foi criado.

## 11. Papéis personalizados

Veja o manual do administrador, seção 10. Em **Configurações > Papéis**, **Novo papel** cria um papel combinando as 15 permissões do catálogo. O catálogo de permissões é fixo, definido pelo produto. A empresa cria quantos papéis precisar, mas não permissões novas.

Exemplo: um papel "Conciliador sênior" com Painel, Importação (ver e importar), Conciliação (todas, menos "Aprovar"), e Exportar relatórios.

## 12. Módulos, planos, integrações, notificações, modelos de relatório, retenção e segurança

### 12.1 Planos e módulos

Os módulos obrigatórios estão sempre ativos: **Conciliação**, **Acesso** e **Auditoria**. Os opcionais dependem de duas condições: estar **no plano** da empresa e estar **habilitado** pela empresa em **Configurações > Módulos** (botão **Habilitar**, exige a permissão "Habilitar e desabilitar módulos"; módulo fora do plano fica desabilitado, com a dica "Fora do plano da empresa").

O que cada plano inclui:

| Módulo | Essencial | Profissional | Corporativo |
|---|:-:|:-:|:-:|
| Transferências internas (`transfers`) | S | S | S |
| Aprovação em duas etapas (`approvals`) | - | S | S |
| Agrupamento (`grouping`) | - | S | S |
| API de lançamentos (`api.inbound`) | - | S | S |
| Notificações por webhook (`notifications.webhook`) | - | S | S |
| Notificações por e-mail (`notifications.email`) | - | S | S |
| Conector REST (`connector.rest`) | - | - | S |
| Sugestões por IA (`ai.assist`) | - | - | S |

Resumo de cada módulo opcional:

- **Aprovação em duas etapas**: decisões definidas nas regras exigem aprovação de uma segunda pessoa.
- **Agrupamento**: sugere uma transação como soma de vários lançamentos, e o inverso.
- **Transferências internas**: pareia débito e crédito entre contas bancárias da própria empresa.
- **API de lançamentos**: recebe lançamentos do sistema financeiro por API autenticada com token.
- **Conector REST**: busca lançamentos em uma API REST do sistema financeiro (depende da API do cliente).
- **Notificações por webhook**: envia eventos assinados para um endereço HTTPS da empresa.
- **Notificações por e-mail**: envia avisos por e-mail usando o SMTP da empresa.
- **Sugestões por IA**: sugere categoria para transações sem correspondência, sempre com aceite humano (depende de provedor de IA e chave da empresa).

Quando uma empresa é criada, só **Transferências internas** e **Agrupamento** (se o plano os inclui) vêm habilitados. Os demais são habilitados pelo administrador.

Os planos (Essencial, Profissional, Corporativo) são cadastrados no banco. **Não há tela para criar ou editar planos** (seção 14). O operador escolhe o plano da empresa em **Empresas > Licença**.

### 12.2 Limites de licença

Cada plano tem três limites; o operador pode **substituí-los por empresa** na tela **Licença** da empresa (**Limites (substituem o plano)**). Em branco usa o limite do plano; "ilimitado" remove o limite.

| Limite | Essencial | Profissional | Corporativo |
|---|---:|---:|---:|
| **Máximo de usuários** (ativos) | 5 | 25 | sem limite |
| **Máximo de contas bancárias** (ativas) | 3 | 15 | sem limite |
| **Máximo de transações por mês** | 5.000 | 50.000 | sem limite |

Ao atingir o limite, a criação de usuários ou contas é recusada com mensagem explicativa, e a importação que ultrapassaria as transações do mês também.

A **Situação** da licença: **Avaliação**, **Ativa**, **Em atraso**, **Suspensa** e **Cancelada**. Com a licença **Suspensa** ou **Cancelada**, vencida (**Validade**), ou com a empresa suspensa ou arquivada, a empresa fica em **somente leitura**: consulta e exporta, mas não altera. O administrador vê tudo em **Configurações > Licença**.

### 12.3 Integrações

**Configurações > Integrações** (permissão "Gerenciar integrações e credenciais"). Cada tipo depende do módulo correspondente. Passos comuns:

1. Em **Nova integração**, no bloco do tipo desejado, preencha **Nome** e os campos do tipo.
2. Informe o segredo (campo de senha). **O segredo só é gravado, nunca exibido depois.** Ao editar, escolha **Manter o segredo atual**, **Substituir por um novo** ou **Remover o segredo**.
3. Salve e clique em **Testar conexão**. A situação **Verificada** só aparece depois que o serviço responde de verdade ao teste. Qualquer mudança de configuração ou segredo zera a situação e exige novo teste. Erros aparecem em "Último erro".
4. **Integração ativa** liga e desliga sem excluir.

| Tipo | Campos principais | Observações |
|---|---|---|
| **Webhook** | **Endereço do webhook**; **Segredo de assinatura** | Cada envio é assinado no cabeçalho `X-Concilia-Signature`. Módulo **Notificações por webhook**. |
| **E-mail (SMTP)** | **Servidor SMTP**, **Porta**, **Usuário**, **Remetente**, **Conexão segura (TLS direto)**; **Senha do SMTP** | Deixe o usuário vazio se o servidor não exige autenticação. Módulo **Notificações por e-mail**. |
| **Conector REST de lançamentos** | **Endereço base**, **Caminho**, **Autenticação** (**Sem autenticação**, **Token (Bearer)**, **Cabeçalho personalizado**, **Usuário e senha (Basic)**), **Caminho da lista na resposta**, **Unidade do valor** (**Decimal (reais)** ou **Centavos inteiros**), **Parâmetro de início do período**, **Parâmetro de fim do período**, **Conta bancária padrão**, **Mapa de campos** | O **Mapa de campos** diz, para cada campo (data, valor e descrição obrigatórios; identificador, documento, referência, contraparte, vencimento, conta, centro de custo, categoria opcionais), o caminho, com pontos, no item devolvido pela API (ex.: `valor.total`). Use **Buscar lançamentos** para trazer um período, que entra como um lote de importação. Módulo **Conector REST**. |
| **Provedor de IA** | **Provedor** (Anthropic), **Modelo**, **Endereço alternativo da API** (opcional); **Chave de API** | Só são enviados ao provedor a descrição normalizada, o sinal, o tipo e os nomes das categorias. Módulo **Sugestões por IA**. |

Nenhuma integração fica "Verificada" sem uma chamada real bem-sucedida. Em instalações de produção, endereços de rede privada são bloqueados por segurança (configuração de instalação).

### 12.4 Tokens de API

**Configurações > Tokens de API** ("Credenciais para o sistema financeiro enviar lançamentos por API"), com o módulo **API de lançamentos**:

1. Clique em **Novo token**.
2. Preencha **Nome** (quem usa, por exemplo "ERP financeiro"), marque o escopo **Enviar lançamentos (ledger:write)** (o único que existe hoje) e, se quiser, **Validade (opcional)**. Sem data, o token vale até ser revogado.
3. Salve. O token aparece **uma única vez**, com a opção de copiar. Entregue-o à equipe do sistema financeiro.
4. A lista mostra **Prefixo**, **Escopos**, **Validade**, **Último uso** e **Situação** (**Ativo**, **Expirado**, **Revogado**). **Revogar** invalida o token.

A tela traz o bloco "Como enviar lançamentos". Os detalhes técnicos da API estão em `04-api-e-conectores.md`.

### 12.5 Notificações

**Configurações > Notificações** (permissão "Alterar configurações e cadastros") tem as abas **Regras** e **Entregas**.

1. Em **Regras**, clique em **Nova regra**.
2. Escolha o **Evento**: **Importação concluída**, **Importação com falha**, **Conciliação concluída**, **Aprovação solicitada** ou **Trabalho em falha definitiva**.
3. Escolha o **Canal**: **Aviso interno**, **E-mail** ou **Webhook** (e-mail e webhook aparecem como "módulo inativo" se o módulo não estiver ativo).
4. Defina o destino: para **Aviso interno**, os **Papéis que recebem o aviso**; para **E-mail**, os **E-mails de destino** (um por linha ou separados por vírgula, até 20) e a **Integração SMTP**; para **Webhook**, a **Integração de webhook**.
5. Mantenha **Regra ativa** marcada e salve.

Em **Entregas** você acompanha cada envio externo: **Data**, **Evento**, **Canal**, **Situação** (**Pendente**, **Enviada**, **Falhou**, **Ignorada**), **Tentativas** e **Erro**.

Independente das regras, **Aprovação solicitada** avisa quem pode aprovar, e **Trabalho em falha definitiva** avisa quem pode alterar configurações. Os demais eventos só geram aviso interno se houver regra.

### 12.6 Modelos de relatório

**Configurações > Modelos de relatório**: a tela cria e edita **Nome**, **Tipo** (**Itens** ou **Resumo**) e **Modelo padrão deste tipo** (só um por tipo; este substitui o anterior). O modelo escolhido em **Relatórios > Modelo de relatório** é usado na exportação; sem escolha, usa-se o padrão.

O conteúdo do modelo (título, colunas, rodapé) é uma configuração guardada com o modelo. Hoje a tela **não** edita esse conteúdo; ele é definido na criação da empresa (títulos "Itens de conciliação" e "Relatório de conciliação bancária", colunas Data, Descrição, Documento, Valor, Situação, Tipo e Conta) ou pela API (`/api/v1/report-templates`, campo `config`). Chaves aceitas: `title` (até 200 caracteres), `columns` (entre `date`, `description`, `document`, `amount`, `status`, `kind`, `account`, `side`, `category`, `reference`, `counterparty`, `externalId`), `footer` (até 500 caracteres) e, no resumo, `includePending` e `includeDivergent`. Peça a personalização à equipe técnica.

### 12.7 Retenção e segurança

**Configurações > Segurança**:

| Campo | O que faz | Padrão | Limites |
|---|---|---|---|
| **Inatividade da sessão** (minutos) | Tempo sem uso até pedir nova entrada | 60 | 5 a 1.440 |
| **Tamanho mínimo da senha** (caracteres) | Vale para senhas novas e trocas; as atuais continuam até serem trocadas | 10 | 8 a 64 |
| **Manter arquivos originais indefinidamente** / **Prazo de retenção** (dias) | Quanto tempo guardar o arquivo original de cada importação | Indefinidamente | 30 a 3.650 |

**Importante sobre a retenção:** o trabalhador apaga uma vez por dia os arquivos originais de importações processadas há mais dias que o prazo configurado (veja `08-operacao-backup-recuperacao.md`). O lote, o hash do arquivo, as estatísticas, os dados importados e a trilha de auditoria continuam guardados; só o arquivo original some, e baixá-lo, pré-visualizá-lo ou reprocessá-lo passa a ser recusado com aviso de arquivo expurgado.

Outras garantias que não se configuram, mas valem para toda empresa: cada empresa só enxerga os próprios dados; segredos de integração são cifrados e nunca devolvidos; a auditoria é encadeada.

---

## 13. O que é por empresa e o que é por instalação

**Por empresa (no banco, pela interface; mudam sem reiniciar nada):** dados da empresa; identidade visual; estrutura; plano de contas e categorias; contas bancárias; regras e tolerâncias; aprovações; regras de classificação; perfis de importação; usuários e papéis; módulos habilitados; integrações e tokens; regras de notificação; modelos de relatório; sessão, senha e retenção. A **licença** (plano, situação, validade, limites) é por empresa, mas só o operador da plataforma altera.

**Por instalação (variáveis de ambiente do servidor; exigem equipe técnica e, em geral, reinicialização):**

| Variável | O que controla | Padrão |
|---|---|---|
| `DEPLOYMENT_MODE` | `multi` (várias empresas) ou `single` (uma só) | `multi` |
| `PRODUCT_NAME` | Nome do produto exibido quando não há logotipo | Concilia |
| `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL` | Ambiente, endereço, porta e nível de log | desenvolvimento, 0.0.0.0, 3000, info |
| `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DB_APP_ROLE`, `DB_POOL_MAX` | Conexão com o PostgreSQL | veja `.env.example` |
| `SESSION_SECRET`, `SECRETS_MASTER_KEY`, `SECRETS_KEY_VERSION` | Segredos de sessão e chave que cifra segredos de integração | obrigatórios |
| `COOKIE_SECURE` | Cookie só por HTTPS (obrigatório em produção) | false |
| `SESSION_ABSOLUTE_HOURS` | Duração máxima de uma sessão | 12 |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES` | Tentativas erradas e tempo de bloqueio | 5 e 15 |
| `PASSWORD_SCRYPT_COST`, `RATE_LIMIT_ENABLED`, `TRUST_PROXY` | Custo da senha, limite de requisições, proxy reverso | 17, true, false |
| `WORKER_ENABLED`, `WORKER_POLL_MS`, `WORKER_CONCURRENCY`, `JOB_TIMEOUT_SECONDS` | Trabalhos em segundo plano | true, 1000, 2, 600 |
| `MAX_UPLOAD_MB`, `MAX_IMPORT_ROWS` | Tamanho e linhas máximas por importação | 15 e 100.000 |
| `ALLOW_PRIVATE_INTEGRATION_HOSTS` | Integrações com endereços privados (nunca em produção) | false |
| `METRICS_TOKEN`, `WEB_DIST_DIR` | Métricas e pasta do front-end | vazio |
| `TEMPLATES_DIR` | Pasta dos modelos de plano de contas | `config/templates` |

Instalação e atualização: `05-instalacao-e-atualizacao.md`.

## 14. O que não é configurável hoje

Verificado no código desta versão. Estes pontos exigiriam desenvolvimento ou ação técnica fora da interface:

- **Criar ou editar planos**, ou o conjunto de módulos e limites de um plano. Os três planos (Essencial, Profissional, Corporativo) estão no banco, e só há leitura pela interface. Mudar um plano exige alterar o banco (nova migração) ou usar os limites por empresa.
- **Criar novos módulos** ou novos escopos de token de API (hoje só `ledger:write`).
- **Criar novas permissões.** O catálogo é fixo; só os papéis são configuráveis. Papéis do sistema (Administrador, Gestor, Analista, Auditor) não podem ser editados.
- **Criar novas regras do motor de conciliação**, mudar os pesos da confiança (35/15/20/10/20) ou o limite de semelhança de descrição (50%). Só os parâmetros da seção 7 são ajustáveis.
- **Expressões regulares** nas regras de classificação (não existem, de propósito); só os quatro tipos de comparação.
- **Conexão direta com bancos** (open banking, coleta automática de extratos): o produto não faz.
- **Escrever no sistema financeiro**: o produto só lê (por arquivo, API de entrada ou conector REST) e exporta pendências.
- **Perfis de importação para OFX** e formatos além de OFX, CSV e XLSX (por exemplo CNAB, PDF).
- **Outros provedores de IA**: hoje só há Anthropic na lista de provedores.
- **Conteúdo dos modelos de relatório pela tela** (título, colunas, rodapé): só pela API. O relatório de **Lançamentos a criar** tem formato fixo.
- **Aplicar outro modelo de plano de contas pelo botão** da tela: o botão aplica só o `plano-de-contas-basico`. Outros modelos são aplicados pela API.
- **Idioma e formato regional**: a interface é em português do Brasil, com valores em reais e datas AAAA-MM-DD por trás. Não há troca de idioma.
- **Tema escuro** e outros aspectos visuais além da cor principal e do logotipo.
- **Autenticação única (SSO), segundo fator (2FA) e integração com diretório de usuários**: não há. O acesso é por e-mail e senha.
- **Cobrança e pagamento da licença**: não há provedor de pagamento; a licença é gerida pelo operador.
