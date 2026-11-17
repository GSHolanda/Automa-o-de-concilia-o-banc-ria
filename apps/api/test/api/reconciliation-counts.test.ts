import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, buildTestApp, createTenant, loggedIn, userWithRole, type TestTenant } from '../helpers/app';
import { closePools } from '../helpers/db';
import { createBankAccount, type TestBankAccount } from '../helpers/imports';
import { importLedger, importStatement, runReconciliation } from '../helpers/reconciliation';

let app: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;
let admin: ApiClient;
let otherAdmin: ApiClient;
let auditor: ApiClient;
let account: TestBankAccount;

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'contagens' });
  other = await createTenant({ label: 'contagens-outra' });
  admin = await loggedIn(app, tenant.adminEmail);
  otherAdmin = await loggedIn(app, other.adminEmail);
  auditor = await userWithRole(app, admin, 'auditor');
  account = await createBankAccount(tenant.tenantId, { name: 'Conta C', accountNumber: '22222-2', externalRef: 'CC-C' });
  await importStatement(app, admin, account, [
    { date: '2024-01-05', amount: '1500.00', memo: 'PIX RECEBIDO CLIENTE ALFA NF 4512' },
    { date: '2024-01-10', amount: '-320.00', memo: 'PAGAMENTO BOLETO' },
    { date: '2024-01-12', amount: '980.00', memo: 'PIX RECEBIDO CLIENTE BETA NF 7788' },
    { date: '2024-01-15', amount: '-35.90', memo: 'TARIFA PACOTE SERVICOS' },
  ]);
  await importLedger(app, admin, [
    { date: '05/01/2024', description: 'RECEBIMENTO CLIENTE ALFA', document: '4512', amount: '1.500,00', account: 'CC-C' },
    { date: '10/01/2024', description: 'PAGAMENTO FORNECEDOR XAVIER', amount: '-320,00', account: 'CC-C' },
    { date: '10/01/2024', description: 'PAGAMENTO FORNECEDOR YARA', amount: '-320,00', account: 'CC-C' },
    { date: '12/01/2024', description: 'RECEBIMENTO CLIENTE BETA', document: '7788', amount: '950,00', account: 'CC-C' },
  ]);
  await runReconciliation(app, admin, account.id, '2024-01-01', '2024-01-31');
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('GET /reconciliation/counts', () => {
  it('conta itens por situação (extrato e lançamentos) e as sugestões abertas', async () => {
    const response = await admin.get(`/reconciliation/counts?bankAccountId=${account.id}`);
    expect(response.status).toBe(200);
    const suggested = await admin.get(`/reconciliation/matches?status=suggested&bankAccountId=${account.id}&limit=200`);
    expect(response.body).toEqual({
      suggestions: suggested.body.items.length,
      pending: 4,
      awaitingApproval: 0,
      divergent: 2,
      reconciled: 2,
      ignored: 0,
    });
    expect(response.body.suggestions).toBeGreaterThan(0);
  });

  it('aplica os mesmos filtros dos itens, inclusive às sugestões', async () => {
    const base = `/reconciliation/counts?bankAccountId=${account.id}`;
    const byDate = await admin.get(`${base}&dateFrom=2024-01-11&dateTo=2024-01-15`);
    expect(byDate.body).toMatchObject({ divergent: 2, pending: 1, reconciled: 0 });
    const byText = await admin.get(`${base}&q=yara`);
    expect(byText.body).toMatchObject({ pending: 1, divergent: 0, reconciled: 0 });
    expect(byText.body.suggestions).toBe(1);
    const none = await admin.get(`${base}&q=nao-existe-xyz`);
    expect(none.body).toEqual({ suggestions: 0, pending: 0, awaitingApproval: 0, divergent: 0, reconciled: 0, ignored: 0 });
    expect((await admin.get('/reconciliation/counts?amountMin=abc')).status).toBe(400);
  });

  it('exige permissão de consulta e respeita o isolamento entre empresas', async () => {
    expect((await auditor.get('/reconciliation/counts')).status).toBe(200);
    expect((await new ApiClient(app).get('/reconciliation/counts')).status).toBe(401);
    const foreign = await otherAdmin.get('/reconciliation/counts');
    expect(foreign.body).toEqual({ suggestions: 0, pending: 0, awaitingApproval: 0, divergent: 0, reconciled: 0, ignored: 0 });
  });
});

describe('filtros de período, texto e valor nas sugestões', () => {
  const list = async (query: string) => {
    const response = await admin.get(`/reconciliation/matches?status=suggested&bankAccountId=${account.id}&limit=200${query}`);
    expect(response.status).toBe(200);
    return response.body.items as { bank: { description: string }[]; ledger: { description: string; date: string }[] }[];
  };

  it('filtra por texto, período, valor, direção e tipo no servidor', async () => {
    const all = await list('');
    expect(all.length).toBeGreaterThanOrEqual(3);
    const yara = await list('&q=yara');
    expect(yara).toHaveLength(1);
    expect(yara[0]!.ledger[0]!.description).toContain('YARA');
    expect(await list('&q=nao-existe-xyz')).toHaveLength(0);

    const late = await list('&dateFrom=2024-01-14');
    expect(late.length).toBeGreaterThan(0);
    expect(late.length).toBeLessThan(all.length);
    expect(await list('&dateTo=2023-12-31')).toHaveLength(0);

    const big = await list('&amountMin=90000');
    expect(big.every((m) => [...m.bank, ...m.ledger].some((i) => /ALFA|BETA/.test(i.description)))).toBe(true);
    expect(await list('&amountMax=1000')).not.toHaveLength(all.length);
    const debits = await list('&direction=debit');
    expect(debits.length).toBeGreaterThan(0);
    expect(await list('&kind=fee')).not.toHaveLength(0);
  });
});
