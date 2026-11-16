# Arquivos de demonstração (fictícios)

Todos os nomes, contas, clientes, fornecedores, documentos e valores são **inventados**. A empresa é "Comércio Exemplo Ltda", o banco é fictício (código 0999) e o período é janeiro de 2024. Nenhum dado real é usado.

Os arquivos são gerados por `apps/api/src/demo/files.ts` e gravados em `demo/files/` com:

    pnpm --filter @concilia/api exec tsx src/demo/write-files.ts

| Arquivo | Tipo | Conteúdo |
|---|---|---|
| `extrato-movimento-2024-01.ofx` | extrato OFX 1.x (Windows-1252) da conta MOVIMENTO | 37 transações: 13 recebimentos com NF, 8 pagamentos a fornecedores, 5 recebimentos sem documento, 2 avulsos de R$ 750,00, depósito de lote de cartões de R$ 3.600,00, tarifas, boleto de energia com estorno, transferência de R$ 10.000,00 para a reserva e 2 lançamentos sem correspondência |
| `extrato-movimento-2024-01-complemento.ofx` | extrato OFX da mesma conta, de 25/01 a 31/01 | 9 transações repetidas do arquivo principal (mesmos FITID) e 3 novas |
| `extrato-reserva-2024-01.csv` | extrato CSV (UTF-8, separador `;`) da conta RESERVA | saldo anterior, crédito de R$ 10.000,00 em 20/01 e outros 4 movimentos |
| `lancamentos-2024-01.xlsx` | planilha de lançamentos do sistema de origem | 34 lançamentos: correspondentes aos itens do extrato (com data de 0 a 3 dias antes e, em alguns casos, valor diferente), 3 lançamentos de cartões somando R$ 3.600,00 e 3 sem correspondência no extrato |

Os testes que validam estes arquivos estão em `apps/api/test/demo/files.test.ts`.
