import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { ApiClient } from './app';
import {
  bankTransactionsOf,
  buildCsv,
  buildOfx,
  drainJobs,
  importFile,
  ledgerEntriesOf,
  type OfxTransactionInput,
  type TestBankAccount,
} from './imports';

/** Extrato fictício de uma conta, importado por OFX. Devolve as transações em ordem de linha. */
export async function importStatement(
  app: FastifyInstance,
  client: ApiClient,
  account: TestBankAccount,
  transactions: OfxTransactionInput[],
): Promise<any[]> {
  const tag = randomBytes(4).toString('hex');
  const content = buildOfx({
    accountId: account.accountNumber ?? '0',
    transactions: transactions.map((transaction, index) => ({
      ...transaction,
      fitId: transaction.fitId ?? `R${tag}${index}`,
    })),
  });
  const imported = await importFile(app, client, {
    sourceKind: 'bank',
    bankAccountId: account.id,
    fileName: `extrato-${tag}.ofx`,
    content,
  });
  expect(imported.batch.status).toBe('completed');
  return bankTransactionsOf(imported.batchId);
}

export interface LedgerRow {
  /** Data no formato do arquivo (DD/MM/AAAA). */
  date: string;
  description: string;
  /** Valor como aparece no arquivo (ex.: "-320,00"). */
  amount: string;
  document?: string;
  /** Referência da conta no sistema financeiro (external_ref da conta bancária). */
  account?: string;
}

const LEDGER_CONFIG = {
  config: {
    columns: {
      date: 'Data',
      description: ['Descrição'],
      amount: 'Valor',
      externalId: 'ID',
      document: 'Documento',
      bankAccountRef: 'Conta',
    },
  },
};

/** Lançamentos fictícios do sistema financeiro, importados por CSV. Devolve os lançamentos em ordem de linha. */
export async function importLedger(app: FastifyInstance, client: ApiClient, rows: LedgerRow[]): Promise<any[]> {
  const tag = randomBytes(4).toString('hex');
  const content = buildCsv([
    ['ID', 'Data', 'Descrição', 'Documento', 'Valor', 'Conta'],
    ...rows.map((row, index) => [`L${tag}${index}`, row.date, row.description, row.document ?? '', row.amount, row.account ?? '']),
  ]);
  const imported = await importFile(
    app,
    client,
    { sourceKind: 'ledger', fileName: `lancamentos-${tag}.csv`, content },
    LEDGER_CONFIG,
  );
  expect(imported.batch.status).toBe('completed');
  return ledgerEntriesOf(imported.batchId);
}

/** Pede a execução, drena a fila e devolve a execução concluída. */
export async function runReconciliation(
  app: FastifyInstance,
  client: ApiClient,
  bankAccountId: string,
  periodStart: string,
  periodEnd: string,
): Promise<any> {
  const requested = await client.post('/reconciliation/runs', { bankAccountId, periodStart, periodEnd });
  expect(requested.status, JSON.stringify(requested.body)).toBe(202);
  await drainJobs(app);
  const run = await client.get(`/reconciliation/runs/${requested.body.runId}`);
  expect(run.status).toBe(200);
  return run.body;
}

/** Conciliações (de qualquer situação) que contêm o item indicado. */
export async function matchesWith(client: ApiClient, itemId: string, query = ''): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.get(
      `/reconciliation/matches?limit=200${query ? `&${query}` : ''}${cursor ? `&cursor=${cursor}` : ''}`,
    );
    expect(response.status).toBe(200);
    items.push(...response.body.items);
    cursor = response.body.nextCursor;
  } while (cursor);
  return items.filter((match) =>
    [...match.bank, ...match.ledger].some((item: { id: string }) => item.id === itemId),
  );
}

export async function itemStatus(client: ApiClient, side: 'bank' | 'ledger', id: string): Promise<string> {
  const response = await client.get(`/reconciliation/items/${side}/${id}`);
  expect(response.status).toBe(200);
  return response.body.item.status;
}
