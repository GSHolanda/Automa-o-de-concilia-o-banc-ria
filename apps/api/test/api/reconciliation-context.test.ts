import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, buildTestApp, createTenant, loggedIn, type TestTenant } from '../helpers/app';
import { closePools } from '../helpers/db';
import { createBankAccount } from '../helpers/imports';
import { importLedger, importStatement, itemStatus, matchesWith, runReconciliation } from '../helpers/reconciliation';

/**
 * Achado 1 da revisão de segurança: a unicidade que autoriza conciliação automática
 * considera também concorrentes fora do recorte da execução.
 */
let app: FastifyInstance;
let tenant: TestTenant;
let admin: ApiClient;

const ids = (items: { id: string }[]) => items.map((item) => item.id);

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'contexto' });
  admin = await loggedIn(app, tenant.adminEmail);
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('concorrentes fora do recorte da execução', () => {
  it('não concilia sozinho quando a transação concorrente está um dia depois do fim do período', async () => {
    const account = await createBankAccount(tenant.tenantId, { name: 'Conta Borda', accountNumber: '40001-1', externalRef: 'CC-BORDA' });
    const [march, april] = await importStatement(app, admin, account, [
      { date: '2024-03-31', amount: '500.00', memo: 'PIX RECEBIDO CLIENTE UM' },
      { date: '2024-04-01', amount: '500.00', memo: 'PIX RECEBIDO CLIENTE DOIS' },
    ]);
    const [entry] = await importLedger(app, admin, [
      { date: '01/04/2024', description: 'RECEBIMENTO CLIENTE DOIS', amount: '500,00', account: 'CC-BORDA' },
    ]);

    const run = await runReconciliation(app, admin, account.id, '2024-03-01', '2024-03-31');
    expect(run.stats).toMatchObject({ bankItems: 1, autoMatched: 0 });

    expect(await itemStatus(admin, 'ledger', entry.id)).toBe('pending');
    expect(await itemStatus(admin, 'bank', march.id)).toBe('pending');
    const marchMatches = await matchesWith(admin, march.id);
    for (const match of marchMatches) {
      expect(match).toMatchObject({ status: 'suggested', autoConfirmed: false, ambiguous: true });
    }
    // A transação de abril só serve de contexto: não recebe conciliação nem sugestão nesta execução.
    expect(await matchesWith(admin, april.id)).toHaveLength(0);
    expect(await itemStatus(admin, 'bank', april.id)).toBe('pending');
  });

  it('não concilia sozinho lançamento sem conta disputado por transação idêntica em outra conta', async () => {
    const accountA = await createBankAccount(tenant.tenantId, { name: 'Conta A', accountNumber: '40002-2', externalRef: 'CC-A' });
    const accountB = await createBankAccount(tenant.tenantId, { name: 'Conta B', accountNumber: '40003-3', externalRef: 'CC-B' });
    const [inA] = await importStatement(app, admin, accountA, [
      { date: '2024-05-10', amount: '-1000.00', memo: 'PAGAMENTO FORNECEDOR ZETA' },
    ]);
    const [inB] = await importStatement(app, admin, accountB, [
      { date: '2024-05-10', amount: '-1000.00', memo: 'PAGAMENTO FORNECEDOR ZETA' },
    ]);
    const [entry] = await importLedger(app, admin, [
      { date: '10/05/2024', description: 'PAGAMENTO FORNECEDOR ZETA', amount: '-1.000,00' },
    ]);
    expect(entry.bank_account_id).toBeNull();

    const run = await runReconciliation(app, admin, accountA.id, '2024-05-01', '2024-05-31');
    expect(run.stats).toMatchObject({ bankItems: 1, ledgerItems: 1, autoMatched: 0 });
    expect(await itemStatus(admin, 'ledger', entry.id)).toBe('pending');
    expect(await itemStatus(admin, 'bank', inA.id)).toBe('pending');

    const suggested = await matchesWith(admin, entry.id);
    expect(suggested).toHaveLength(1);
    expect(suggested[0]).toMatchObject({ status: 'suggested', autoConfirmed: false, ambiguous: true });
    expect(ids(suggested[0].bank)).toEqual([inA.id]);
    // A transação da conta B só serve de contexto nesta execução.
    expect(await matchesWith(admin, inB.id)).toHaveLength(0);
  });

  it('continua conciliando sozinho o lançamento sem conta quando nenhuma outra conta o disputa', async () => {
    const accountA = await createBankAccount(tenant.tenantId, { name: 'Conta Única', accountNumber: '40004-4', externalRef: 'CC-U' });
    await createBankAccount(tenant.tenantId, { name: 'Conta Vazia', accountNumber: '40005-5', externalRef: 'CC-V' });
    const [inA] = await importStatement(app, admin, accountA, [
      { date: '2024-07-10', amount: '-777.00', memo: 'PAGAMENTO FORNECEDOR ETA' },
    ]);
    const [entry] = await importLedger(app, admin, [
      { date: '10/07/2024', description: 'PAGAMENTO FORNECEDOR ETA', amount: '-777,00' },
    ]);

    const run = await runReconciliation(app, admin, accountA.id, '2024-07-01', '2024-07-31');
    expect(run.stats).toMatchObject({ autoMatched: 1 });
    expect(await itemStatus(admin, 'bank', inA.id)).toBe('reconciled');
    expect(await itemStatus(admin, 'ledger', entry.id)).toBe('reconciled');
  });
});
