# 11. Limitações, riscos e dependências externas

Consolida o que não foi verificado de verdade, o que o produto não faz, os riscos de operação e as pendências da revisão de segurança. Cada item tem uma linha de mitigação ou próximo passo sugerido. Os números de testes estão em `10-testes-e-resultados.md`.

## 1. Dependências externas e o que não foi verificado

| Item | O que foi verificado | O que NÃO foi verificado | Mitigação ou próximo passo |
|---|---|---|---|
| Webhook de notificação | Entrega e assinatura testadas contra servidor local de teste | Chamada a um endpoint HTTPS real de terceiros; TLS real | Validar com um endpoint de teste controlado pelo cliente antes de liberar; a situação só vira `verified` após resposta real |
| SMTP | Envio testado contra servidor local; recusa de SMTP inalcançável testada | TLS real, autenticação SMTP real, entregabilidade | Testar com o provedor de e-mail do cliente antes da implantação; registrar a credencial no cofre da empresa |
| Conector REST (leitura de lançamentos) | Leitura, paginação e isolamento testados contra servidor local | Sistema financeiro de origem real; limites de taxa e formato reais do sistema | Validar com um ambiente de homologação do sistema de origem; manter o conector só de leitura |
| Provedor de IA (`@anthropic-ai/sdk`) | Adaptador testado contra servidor local; chave recusada e servidor inalcançável viram erro sem expor a chave | Nenhuma chamada ao serviço real: não há chave no ambiente | Chamar o serviço real com uma chave de teste antes de usar a sugestão por IA; até lá, a funcionalidade fica desligada na prática (sem integração verificada, a rota responde 409) |
| Docker e Docker Compose | Arquivos escritos e com sintaxe validada | Nenhuma execução de imagem ou de compose | Rodar `docker compose up` em ambiente limpo antes de publicar a imagem; o caminho sem Docker está em `05-instalacao-e-atualizacao.md` |
| `safeFetch` contra destino HTTPS público | Recusa de endereço privado, loopback, link-local e faixas IPv6 de transição testada | Chamada bem-sucedida a um destino HTTPS público real | Incluir no ensaio de implantação um endereço público de teste; acompanhar `safeFetch` se a lista de faixas bloqueadas mudar |
| TLS e certificados | Não exercitado em nenhum teste | Certificados reais, cadeia de confiança, versões de protocolo | Colocar a API atrás de proxy com TLS (exigência já documentada em `TRUST_PROXY`) e verificar o certificado no ambiente de implantação |
| Vulnerabilidades de dependências | Fora do alcance da revisão de segurança | Varredura de `pnpm audit` ou equivalente não consta da revisão | Rodar auditoria de dependências antes de cada release e fixar versões no lockfile |
| Backup e restauração | Executados localmente conforme o plano | Nenhum teste automatizado no repositório; restauração em ambiente de produção | Ensaiar restauração periódica com o script de `ops/` e registrar o tempo de recuperação |
| Carga e desempenho | Não há testes de carga | Volume real de empresas, de arquivos e de conciliações | Medir com um volume representativo antes da comercialização; ver risco de memória do XLSX na seção 3 |
| IPv6 em rede | Indisponível no ambiente de desenvolvimento | Comportamento real em rede IPv6 | Testar em rede com IPv6 antes de liberar em ambiente que o use |

## 2. Limitações do produto

Cada limitação diz o que acontece hoje e o que fazer enquanto não há solução no produto.

| Limitação | Efeito | Mitigação ou próximo passo |
|---|---|---|
| Sem segundo fator (TOTP, SMS, chave de segurança) | Login só com e-mail e senha | Política de senha forte; limite de tentativas já existe (10 por minuto por IP e e-mail; espera crescente por conta e origem). Planejar 2FA como item de produto |
| Sem login único (SSO, SAML, OIDC) nem diretório externo | Cada usuário tem senha própria | Desativar usuários que saem da empresa (não há exclusão de usuário) |
| Usuário pertence a uma única empresa; e-mail único na instalação | Quem atende duas empresas precisa de dois e-mails | Decisão de produto; ver também o achado 11 da revisão (seção 3) |
| Sem tela para cadastrar planos | Planos (Essencial, Profissional, Corporativo) só mudam por nova migração ou limites por empresa | Operador da plataforma ajusta limites por empresa; criar tela se houver demanda |
| Conteúdo de modelos de relatório só pela API | Título, colunas e rodapé não se editam pela interface | Usar a API (`04-api-e-conectores.md`); o relatório "Lançamentos a criar" tem formato fixo |
| `tenant:purge` não apaga eventos antigos da trilha da plataforma com nome, slug ou CNPJ da empresa | Dado identificador permanece na trilha | Apagar quebraria a cadeia de hashes; registrar a decisão ao atender pedido de eliminação |
| `tenant:purge` trava gravações de todas as empresas durante a transação | Parada curta da instalação durante a eliminação | Executar em janela de manutenção |
| Após `secrets:rotate`, API e trabalhador precisam reiniciar com a chave nova | Janela entre a troca e o reinício | Seguir o procedimento de `08-operacao-backup-recuperacao.md`; a troca é recusada se algum segredo não decifrar |
| Seed de demonstração interrompido deixa a empresa `demo` parcial | Demonstração incompleta | Remover a empresa `demo` antes de rodar de novo |
| Dados do seed são de janeiro de 2024 | Painel abre vazio no mês corrente | Filtrar o período para janeiro de 2024 na demonstração |
| Campos de data usam o controle nativo do navegador | Formato segue o idioma do navegador | Orientar o usuário; o dado interno continua `AAAA-MM-DD` |
| Interface só em português do Brasil | Sem troca de idioma | Aceitar para o mercado-alvo; i18n é item futuro |
| Só OFX, CSV e XLSX; sem perfil de importação para OFX | CNAB e PDF não são lidos | Converter para CSV ou XLSX antes da importação |
| Só provedor Anthropic para IA | Sem outro provedor na lista | Adicionar provedor exige desenvolvimento |
| Sem regras por expressão regular na classificação | Só quatro tipos de comparação | Usar os tipos existentes; é decisão deliberada |
| Pesos da confiança do motor (35/15/20/10/20) e limite de semelhança de descrição (50%) fixos | Não ajustáveis por empresa | Ajustar só pelos parâmetros da seção 7 de `07-manual-de-personalizacao.md`; mudar pesos exige nova versão do motor |
| Sem conexão bancária, sem movimentação de dinheiro, sem escrita no sistema financeiro | Escopo intencional | Exportar pendências e registrar no sistema de origem |
| Sem cobrança ou pagamento da licença | Licença gerida pelo operador | Processo comercial fora do produto |
| Sem tema escuro nem personalização visual além da cor principal e do logotipo | Aparência fixa | Aceitar; item de produto |
| Expurgo de arquivos originais por retenção | Há uma rotina diária (ver seção 4) | Ver divergência na seção 4 |
| Trilha de auditoria e `notification_deliveries` sem política de retenção própria | Crescimento sem limite nessas tabelas | Definir política de arquivamento; hoje só a eliminação da empresa as remove |

## 3. Riscos operacionais

### 3.1 Riscos do documento 09 e do próprio produto

| Risco | Descrição | Mitigação ou próximo passo |
|---|---|---|
| Chave mestra em variável de ambiente | Quem lê o ambiente do processo lê a chave dos segredos; não há KMS ou HSM | Restringir o acesso ao ambiente do servidor; avaliar cofre externo (KMS) como próximo passo |
| Dados em texto no banco | Descrições, valores, nomes, arquivos importados e trilha ficam sem cifra na aplicação | Cifra de volume e de backup na infraestrutura (`ops/backup.sh` não cifra, conforme `09`); documentar como responsabilidade de quem opera |
| Exportação sem cifra | O arquivo gerado contém dados pessoais e financeiros | Proteger o destino e apagar após o uso |
| Verificação da cadeia não detecta remoção do último registro | Quem tem o papel dono do banco pode desabilitar os gatilhos e remover o fim da cadeia | Registrar o `headHash` fora do banco (ver `08-operacao-backup-recuperacao.md`) e conferir periodicamente |
| Sem registro externo do `headHash` | A cadeia é verificável só dentro do banco | Mesma mitigação acima; próximo passo: envio periódico do hash a um registro externo |
| Sem varredura de malware nos arquivos enviados | Arquivo malicioso passa pela importação | Validação de formato, tamanho (`MAX_UPLOAD_MB`) e linhas (`MAX_IMPORT_ROWS`) existe; avaliar antivírus na entrada |
| Sem política de retenção para a trilha e para `notification_deliveries` | Crescimento sem limite | Definir política (ver seção 2) |
| Sem registro de consentimento nem gestão de bases legais | Responsabilidade de LGPD fica com quem opera | Documentar a base legal da empresa cliente; o produto não afirma conformidade (ver aviso em `09`) |
| Eliminação por titular não existe | Não há exclusão de um titular isolado; usuários são desativados | Usar `tenant:purge` para a empresa inteira; avaliar rotina de anonimização por titular |

### 3.2 Pendências parciais da revisão de segurança

A revisão (`docs/revisao-de-seguranca.md`) tem 14 achados. A `HANDOFF` registra todos como corrigidos, com as pendências parciais abaixo. Na elaboração deste documento, verifiquei no código as pendências que são checáveis por leitura; as demais seguem o registro da `HANDOFF`.

| Achado | Pendência parcial | Verificado no código | Mitigação ou próximo passo |
|---|---|---|---|
| 2 (XLSX com alta memória) | Leitura da planilha ainda no processo da API, que também roda o trabalhador | Sim: não há `worker_threads` nem `child_process` em `apps/api/src` | Mover a leitura para processo separado com limite de memória (sugestão da revisão); medir antes |
| 4 (chamada externa na transação) | Pool único para API e trabalhador; sem `idle_in_transaction_session_timeout`; sem teto de trabalhos por empresa | Sim: `DB_POOL_MAX` é um só (padrão 10) em `apps/api/src/config/env.ts`; sem `idle_in_transaction` no código | Pool separado para o trabalhador e timeout no papel da aplicação |
| 3 (segredo enviado a novo destino) | Destino da integração ainda não entra nos dados autenticados da cifra | Sim: a AAD é `empresa:integração` (`apps/api/src/security/secrets.ts`) | Incluir o destino na AAD; a exigência de informar o segredo já mitiga |
| 6 (`users.manage` concede tudo) | Falta a permissão `roles.manage` separada e o aviso aos administradores em mudanças sensíveis | Sim: não existe `roles.manage` em `packages/core/src/permissions.ts` | Criar a permissão e o aviso, conforme a revisão |
| 1 (pareamento por identificador) | CPF e CNPJ podem virar identificador de pareamento | Não encontrei tratamento específico de CPF ou CNPJ em `packages/core/src/text.ts` nem no motor | Tratar CPF e CNPJ como não identificadores de pareamento, ou exigir o valor no mesmo lote |
| Limites por empresa (teto e cota) | Falta limite por empresa nas rotas de teste de integração e de IA, teto da fila, cota de arquivos e expurgo de envios não confirmados | Sim: não há cota nem teto por empresa em `apps/api/src` | Implementar limites por empresa e cota de armazenamento |
| 11 (e-mail entre empresas) | Enumeração de e-mail entre empresas, mitigada por limite | Limite de tentativas existe; a enumeração permanece | Risco aceito pelo ADR-03; reavaliar se o e-mail virar único por empresa |

### 3.3 Riscos de operação

| Risco | Descrição | Mitigação ou próximo passo |
|---|---|---|
| PostgreSQL local desliga com o contêiner | Em ambiente de desenvolvimento, o banco para após reinício | Rodar `pg_ctlcluster 16 main start` antes dos testes |
| Limite de uso da conta de IA | Agentes de desenvolvimento foram interrompidos mais de uma vez | Retomar o mesmo agente em vez de recomeçar (ver `docs/HANDOFF.md` seção 10) |
| Verificação das integrações | Uma integração só vira `verified` com chamada real; até lá, a funcionalidade depende do aceite | Testar cada integração no ambiente do cliente antes de depender dela |

## 4. Divergência entre documentos: expurgo por retenção

`docs/07-manual-de-personalizacao.md` (seção 14) diz que não há rotina que apague os arquivos originais conforme o prazo de retenção. O código contradiz isso: `apps/api/src/jobs/maintenance.ts` agenda o expurgo diário de cada empresa com retenção configurada, e o worker (`apps/api/src/jobs/worker.ts`) verifica a cada hora. Há teste em `apps/api/test/api/retention.test.ts` ("remove o arquivo vencido...").

Próximo passo: corrigir a seção 14 da `07` para refletir a rotina existente, e a linha correspondente da seção 2 deste documento. A correção não foi feita nesta tarefa, por estar fora do escopo.
