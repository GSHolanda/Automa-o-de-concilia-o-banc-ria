import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, buildTestApp, createTenant, loggedIn, userWithRole, type TestTenant } from '../helpers/app';
import { closePools, ownerPool } from '../helpers/db';
import { createBankAccount, drainJobs, type TestBankAccount } from '../helpers/imports';
import {
  importLedger,
  importStatement,
  itemStatus,
  matchesWith,
  runReconciliation,
} from '../helpers/reconciliation';

let app: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;
let admin: ApiClient;
let otherAdmin: ApiClient;
let analyst: ApiClient & { userId: string };
let accountA: TestBankAccount;

/** Ids das transações e lançamentos de janeiro da conta A. */
const jan: Record<string, string> = {};
let janRunId: string;

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'concilia' });
  other = await createTenant({ label: 'concilia-outra' });
  admin = await loggedIn(app, tenant.adminEmail);
  otherAdmin = await loggedIn(app, other.adminEmail);
  analyst = await userWithRole(app, admin, 'analista');
  accountA = await createBankAccount(tenant.tenantId, { name: 'Conta A', accountNumber: '11111-1', externalRef: 'CC-A' });
});

afterAll(async () => {
  await app.close();
  await closePools();
});

async function auditCount(client: ApiClient, action: string, entityId: string): Promise<number> {
  const response = await client.get(`/audit?action=${action}&entityId=${entityId}`);
  expect(response.status).toBe(200);
  return response.body.items.length;
}

describe('motor de conciliação de ponta a ponta', () => {
  it('importa extrato e lançamentos de janeiro e executa a conciliação', async () => {
    const bank = await importStatement(app, admin, accountA, [
      { date: '2024-01-05', amount: '1500.00', memo: 'PIX RECEBIDO CLIENTE ALFA NF 4512' },
      { date: '2024-01-10', amount: '-320.00', memo: 'PAGAMENTO BOLETO' },
      { date: '2024-01-12', amount: '980.00', memo: 'PIX RECEBIDO CLIENTE BETA NF 7788' },
      { date: '2024-01-15', amount: '-35.90', memo: 'TARIFA PACOTE SERVICOS' },
    ]);
    [jan.b1, jan.b2, jan.b3, jan.b4] = bank.map((row) => row.id as string);
    expect(bank[3].kind).toBe('fee');

    const ledger = await importLedger(app, admin, [
      { date: '05/01/2024', description: 'RECEBIMENTO CLIENTE ALFA', document: '4512', amount: '1.500,00', account: 'CC-A' },
      { date: '10/01/2024', description: 'PAGAMENTO FORNECEDOR XAVIER', amount: '-320,00', account: 'CC-A' },
      { date: '10/01/2024', description: 'PAGAMENTO FORNECEDOR YARA', amount: '-320,00', account: 'CC-A' },
      { date: '12/01/2024', description: 'RECEBIMENTO CLIENTE BETA', document: '7788', amount: '950,00', account: 'CC-A' },
    ]);
    [jan.l1, jan.l2, jan.l3, jan.l4] = ledger.map((row) => row.id as string);

    const run = await runReconciliation(app, admin, accountA.id, '2024-01-01', '2024-01-31');
    janRunId = run.id;
    expect(run).toMatchObject({ status: 'completed', bankAccountId: accountA.id, periodStart: '2024-01-01', periodEnd: '2024-01-31' });
    expect(run.engineVersion).toBeTruthy();
    expect(run.rulesSnapshot.dateToleranceDays).toBe(2);
    expect(run.stats).toMatchObject({ bankItems: 4, ledgerItems: 4, autoMatched: 1, suggested: 4, divergences: 1 });
    expect(run.job).toMatchObject({ status: 'succeeded' });
    expect(await auditCount(admin, 'reconciliation.run_completed', run.id)).toBe(1);

    const runs = await admin.get('/reconciliation/runs');
    expect(runs.body.items.map((item: { id: string }) => item.id)).toContain(run.id);
  });

  it('CA-06: mesmo identificador e mesmo valor, únicos dos dois lados, concilia automaticamente com a regra', async () => {
    const [match] = await matchesWith(admin, jan.b1);
    expect(match).toMatchObject({
      status: 'confirmed',
      origin: 'engine',
      autoConfirmed: true,
      type: 'identifier',
      ruleCode: 'ID_VALOR',
      runId: janRunId,
      differenceCents: 0,
    });
    expect(match.engineVersion).toBeTruthy();
    expect(match.ledger.map((item: { id: string }) => item.id)).toEqual([jan.l1]);
    expect(await itemStatus(admin, 'bank', jan.b1)).toBe('reconciled');
    expect(await itemStatus(admin, 'ledger', jan.l1)).toBe('reconciled');
  });

  it('CA-07: dois lançamentos de mesmo valor e data geram duas sugestões e nenhuma conciliação automática', async () => {
    const matches = await matchesWith(admin, jan.b2);
    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(match).toMatchObject({ status: 'suggested', ambiguous: true, autoConfirmed: false, ruleCode: 'VALOR_DATA_AMBIGUO' });
      expect(match.confidence).toBeGreaterThan(0);
      expect(match.confidence).toBeLessThanOrEqual(1);
      expect(match.breakdown).toMatchObject({ amount: 1, competitors: 2 });
    }
    expect(matches.flatMap((match) => match.ledger.map((item: { id: string }) => item.id)).sort()).toEqual(
      [jan.l2, jan.l3].sort(),
    );
    expect(await itemStatus(admin, 'bank', jan.b2)).toBe('pending');
    expect(await itemStatus(admin, 'ledger', jan.l2)).toBe('pending');
  });

  it('CA-08: mesmo identificador com valor diferente gera divergência, não conciliação', async () => {
    const [match, ...rest] = await matchesWith(admin, jan.b3);
    expect(rest).toHaveLength(0);
    expect(match).toMatchObject({
      status: 'suggested',
      ruleCode: 'ID_VALOR_DIVERGENTE',
      divergence: 'amount',
      differenceCents: 3000,
    });
    expect(await itemStatus(admin, 'bank', jan.b3)).toBe('divergent');
    expect(await itemStatus(admin, 'ledger', jan.l4)).toBe('divergent');

    const divergent = await admin.get(`/reconciliation/matches?divergent=true&bankAccountId=${accountA.id}`);
    expect(divergent.body.items.map((item: { id: string }) => item.id)).toEqual([match.id]);
  });

  it('CA-09: tarifa reconhecida por regra aparece como sugestão de classificação', async () => {
    const [match, ...rest] = await matchesWith(admin, jan.b4);
    expect(rest).toHaveLength(0);
    expect(match).toMatchObject({ status: 'suggested', type: 'classification', ruleCode: 'CLASSIFICACAO_REGRA' });
    expect(match.ledger).toHaveLength(0);
    const byType = await admin.get('/reconciliation/matches?type=classification&status=suggested');
    expect(byType.body.items.map((item: { id: string }) => item.id)).toContain(match.id);
  });

  it('filtra e pesquisa itens dos dois lados', async () => {
    const ids = (response: { body: { items: { id: string }[] } }) => response.body.items.map((item) => item.id).sort();
    const base = `/reconciliation/items?bankAccountId=${accountA.id}`;

    const suggested = await admin.get(`${base}&side=bank&hasSuggestion=true`);
    expect(suggested.status).toBe(200);
    expect(ids(suggested)).toEqual([jan.b2, jan.b3, jan.b4].sort());
    const reconciled = await admin.get(`${base}&status=reconciled`);
    expect(ids(reconciled)).toEqual([jan.b1, jan.l1].sort());
    const fees = await admin.get(`${base}&kind=fee`);
    expect(ids(fees)).toEqual([jan.b4]);
    const byText = await admin.get(`${base}&q=7788`);
    expect(ids(byText)).toEqual([jan.b3, jan.l4].sort());
    const byDescription = await admin.get(`${base}&side=ledger&q=yara`);
    expect(ids(byDescription)).toEqual([jan.l3]);
    const byAmount = await admin.get(`${base}&side=bank&amountMin=30000&amountMax=100000`);
    expect(ids(byAmount)).toEqual([jan.b2, jan.b3].sort());
    const byDate = await admin.get(`${base}&dateFrom=2024-01-11&dateTo=2024-01-15`);
    expect(ids(byDate)).toEqual([jan.b3, jan.b4, jan.l4].sort());

    // Paginação por cursor sem repetição
    const first = await admin.get(`${base}&limit=3`);
    expect(first.body.items).toHaveLength(3);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await admin.get(`${base}&limit=3&cursor=${first.body.nextCursor}`);
    const all = [...ids(first), ...ids(second)];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThanOrEqual(6);

    const sample = suggested.body.items.find((item: { id: string }) => item.id === jan.b2);
    expect(sample).toMatchObject({
      side: 'bank',
      bankAccountId: accountA.id,
      date: '2024-01-10',
      amountCents: -32000,
      status: 'pending',
      openSuggestions: 2,
      activeMatch: null,
    });
  });

  it('mostra o item com a linha bruta e o histórico de decisões', async () => {
    const detail = await admin.get(`/reconciliation/items/bank/${jan.b3}`);
    expect(detail.status).toBe(200);
    expect(detail.body.item).toMatchObject({ id: jan.b3, status: 'divergent', amountCents: 98000 });
    expect(detail.body.raw).toBeTruthy();
    expect(detail.body.history).toHaveLength(1);
    expect(detail.body.history[0]).toMatchObject({ ruleCode: 'ID_VALOR_DIVERGENTE' });

    const match = await admin.get(`/reconciliation/matches/${detail.body.history[0].id}`);
    expect(match.status).toBe(200);
    expect(match.body.bank[0]).toMatchObject({ id: jan.b3, amountCents: 98000 });
    expect(match.body.ledger[0]).toMatchObject({ id: jan.l4, amountCents: 95000 });

    expect((await admin.get(`/reconciliation/items/bank/${jan.l1}`)).status).toBe(404);
  });

  it('aceita em lote só sugestões não ambíguas e sem divergência', async () => {
    const [ambiguous] = await matchesWith(admin, jan.b2);
    const [divergent] = await matchesWith(admin, jan.b3);
    const [classification] = await matchesWith(admin, jan.b4);
    const response = await analyst.post('/reconciliation/matches/bulk-accept', {
      ids: [ambiguous.id, divergent.id, classification.id],
    });
    expect(response.status).toBe(200);
    const byId = Object.fromEntries(response.body.results.map((result: { id: string }) => [result.id, result]));
    expect(byId[ambiguous.id]).toMatchObject({ ok: false, error: { code: 'not_eligible' } });
    expect(byId[divergent.id]).toMatchObject({ ok: false, error: { code: 'not_eligible' } });
    expect(byId[classification.id]).toMatchObject({ ok: true, status: 'confirmed' });
    expect(response.body).toMatchObject({ accepted: 1, failed: 2 });
    expect(await itemStatus(admin, 'bank', jan.b4)).toBe('reconciled');
    expect(await auditCount(admin, 'reconciliation.match_accepted', classification.id)).toBe(1);
  });

  it('rejeitar exige motivo, encerra a sugestão e devolve itens divergentes a pendente', async () => {
    const [divergent] = await matchesWith(admin, jan.b3);
    expect((await analyst.post(`/reconciliation/matches/${divergent.id}/reject`, {})).status).toBe(400);
    const rejected = await analyst.post(`/reconciliation/matches/${divergent.id}/reject`, { reason: 'Valores de notas diferentes' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'rejected', decisionNote: 'Valores de notas diferentes' });
    expect(await itemStatus(admin, 'bank', jan.b3)).toBe('pending');
    expect(await itemStatus(admin, 'ledger', jan.l4)).toBe('pending');
    expect(await auditCount(admin, 'reconciliation.match_rejected', divergent.id)).toBe(1);
    // Já encerrada: nova decisão é recusada
    expect((await analyst.post(`/reconciliation/matches/${divergent.id}/reject`, { reason: 'de novo' })).status).toBe(409);
  });

  it('reexecução não duplica, não mexe em decisões humanas e não repete par rejeitado', async () => {
    const before = await matchesWith(admin, jan.b2);
    const run = await runReconciliation(app, admin, accountA.id, '2024-01-01', '2024-01-31');
    expect(run.status).toBe('completed');
    // Só os itens ainda pendentes entram: b2 e b3 (b1 e b4 já conciliados).
    expect(run.stats).toMatchObject({ bankItems: 2, autoMatched: 0 });

    const b1 = await matchesWith(admin, jan.b1);
    expect(b1).toHaveLength(1);
    expect(b1[0]).toMatchObject({ status: 'confirmed', runId: janRunId });

    const b4 = await matchesWith(admin, jan.b4);
    expect(b4).toHaveLength(1);
    expect(b4[0].status).toBe('confirmed');

    const b3 = await matchesWith(admin, jan.b3);
    expect(b3.map((match) => match.status)).toEqual(['rejected']);
    expect(await itemStatus(admin, 'bank', jan.b3)).toBe('pending');

    // Sugestões ambíguas são substituídas pelas da nova execução, sem duplicar e sem conciliação automática.
    const b2 = await matchesWith(admin, jan.b2);
    const open = b2.filter((match) => match.status === 'suggested');
    expect(open).toHaveLength(2);
    expect(open.every((match) => match.runId === run.id && match.ambiguous)).toBe(true);
    const superseded = b2.filter((match) => match.status === 'superseded').map((match) => match.id).sort();
    expect(superseded).toEqual(before.map((match) => match.id).sort());
    expect(await itemStatus(admin, 'bank', jan.b2)).toBe('pending');
  });

  it('duas aceitações concorrentes de sugestões que disputam o mesmo item: uma responde 409', async () => {
    const open = (await matchesWith(admin, jan.b2)).filter((match) => match.status === 'suggested');
    expect(open).toHaveLength(2);
    const [first, second] = await Promise.all([
      analyst.post(`/reconciliation/matches/${open[0].id}/accept`, { note: 'conferido' }),
      admin.post(`/reconciliation/matches/${open[1].id}/accept`, {}),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.error.code).toBe('already_reconciled');

    const winner = first.status === 200 ? first.body : second.body;
    expect(winner).toMatchObject({ status: 'confirmed', autoConfirmed: false });
    expect(await itemStatus(admin, 'bank', jan.b2)).toBe('reconciled');
    const winnerLedger = winner.ledger[0].id;
    const loserLedger = winnerLedger === jan.l2 ? jan.l3 : jan.l2;
    expect(await itemStatus(admin, 'ledger', winnerLedger)).toBe('reconciled');
    expect(await itemStatus(admin, 'ledger', loserLedger)).toBe('pending');
    const loserMatch = open.find((match) => match.id !== winner.id);
    expect((await admin.get(`/reconciliation/matches/${loserMatch.id}`)).body.status).toBe('superseded');
  });

  it('CA-14: desfazer exige justificativa e permissão, devolve itens a pendente e audita', async () => {
    const [confirmed] = (await matchesWith(admin, jan.b2)).filter((match) => match.status === 'confirmed');
    const ledgerId = confirmed.ledger[0].id;
    expect((await admin.post(`/reconciliation/matches/${confirmed.id}/undo`, {})).status).toBe(400);
    expect((await admin.post(`/reconciliation/matches/${confirmed.id}/undo`, { reason: '  ' })).status).toBe(400);
    const denied = await analyst.post(`/reconciliation/matches/${confirmed.id}/undo`, { reason: 'Engano' });
    expect(denied.status).toBe(403);

    const undone = await admin.post(`/reconciliation/matches/${confirmed.id}/undo`, { reason: 'Lançamento errado' });
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ status: 'undone', undoReason: 'Lançamento errado' });
    expect(undone.body.undoneBy).toBeTruthy();
    expect(await itemStatus(admin, 'bank', jan.b2)).toBe('pending');
    expect(await itemStatus(admin, 'ledger', ledgerId)).toBe('pending');
    expect(await auditCount(admin, 'reconciliation.match_undone', confirmed.id)).toBe(1);

    // Desfeita: os itens ficam livres para nova decisão; desfazer de novo é recusado.
    expect((await admin.post(`/reconciliation/matches/${confirmed.id}/undo`, { reason: 'de novo' })).status).toBe(409);
    const items = await admin.get(`/reconciliation/items?bankAccountId=${accountA.id}&side=bank&status=pending`);
    expect(items.body.items.map((item: { id: string }) => item.id).sort()).toEqual([jan.b2, jan.b3].sort());
  });

  it('desfazer conciliação automática também devolve os itens e a reexecução não a refaz', async () => {
    const [auto] = await matchesWith(admin, jan.b1);
    const undone = await admin.post(`/reconciliation/matches/${auto.id}/undo`, { reason: 'Identificador reaproveitado' });
    expect(undone.status).toBe(200);
    expect(await itemStatus(admin, 'bank', jan.b1)).toBe('pending');
    await runReconciliation(app, admin, accountA.id, '2024-01-01', '2024-01-05');
    const after = await matchesWith(admin, jan.b1);
    expect(after.map((match) => match.status)).toEqual(['undone']);
    expect(await itemStatus(admin, 'bank', jan.b1)).toBe('pending');
  });
});

describe('transferências internas', () => {
  it('CA-10: débito e crédito de mesmo valor em duas contas da empresa são propostos como transferência', async () => {
    const accountB = await createBankAccount(tenant.tenantId, { name: 'Conta B', accountNumber: '22222-2' });
    const accountC = await createBankAccount(tenant.tenantId, { name: 'Conta C', accountNumber: '33333-3' });
    const [debit] = await importStatement(app, admin, accountB, [
      { date: '2024-02-05', amount: '-1000.00', memo: 'TRANSF ENTRE CONTAS MESMA TITULARIDADE' },
    ]);
    const [credit] = await importStatement(app, admin, accountC, [
      { date: '2024-02-05', amount: '1000.00', memo: 'TRANSF ENTRE CONTAS MESMA TITULARIDADE' },
    ]);
    expect(debit.kind).toBe('internal_transfer');

    // Sem o módulo, a regra de transferências fica desligada na execução.
    expect((await admin.put('/modules/transfers', { enabled: false })).status).toBe(200);
    const withoutModule = await runReconciliation(app, admin, accountB.id, '2024-02-01', '2024-02-29');
    expect(withoutModule.rulesSnapshot.transfers.enabled).toBe(false);
    expect(await matchesWith(admin, debit.id)).toHaveLength(0);
    expect((await admin.put('/modules/transfers', { enabled: true })).status).toBe(200);

    const run = await runReconciliation(app, admin, accountB.id, '2024-02-01', '2024-02-29');
    expect(run.rulesSnapshot.transfers.enabled).toBe(true);
    const [match, ...rest] = await matchesWith(admin, debit.id);
    expect(rest).toHaveLength(0);
    expect(match).toMatchObject({ type: 'internal_transfer', ruleCode: 'TRANSFERENCIA_INTERNA', status: 'suggested' });
    expect(match.bank.map((item: { id: string }) => item.id).sort()).toEqual([debit.id, credit.id].sort());
    expect(match.ledger).toHaveLength(0);

    const accepted = await analyst.post(`/reconciliation/matches/${match.id}/accept`, {});
    expect(accepted.status).toBe(200);
    expect(await itemStatus(admin, 'bank', debit.id)).toBe('reconciled');
    expect(await itemStatus(admin, 'bank', credit.id)).toBe('reconciled');
  });
});

describe('conciliação manual, ignorar e classificar', () => {
  let accountD: TestBankAccount;
  const d: Record<string, string> = {};

  beforeAll(async () => {
    accountD = await createBankAccount(tenant.tenantId, { name: 'Conta D', accountNumber: '44444-4', externalRef: 'CC-D' });
    const bank = await importStatement(app, admin, accountD, [
      { date: '2024-04-03', amount: '-1200.00', memo: 'PAGAMENTO LOTE FORNECEDORES' },
      { date: '2024-04-08', amount: '700.00', memo: 'DEPOSITO EM DINHEIRO' },
      { date: '2024-04-20', amount: '-300.00', memo: 'PAGAMENTO DIVERSOS' },
      { date: '2024-04-22', amount: '-99.00', memo: 'COMPRA MATERIAL' },
      { date: '2024-04-25', amount: '-45.00', memo: 'IOF COMPRA EXTERIOR' },
      { date: '2024-04-26', amount: '-60.00', memo: 'SERVICO AVULSO' },
    ]);
    [d.b1, d.b2, d.b3, d.b4, d.b5, d.b6] = bank.map((row) => row.id as string);
    const ledger = await importLedger(app, admin, [
      { date: '04/04/2024', description: 'FORNECEDOR ALFA', amount: '-700,00', account: 'CC-D' },
      { date: '04/04/2024', description: 'FORNECEDOR BETA', amount: '-500,00', account: 'CC-D' },
      { date: '08/04/2024', description: 'DEPOSITO', amount: '690,00', account: 'CC-D' },
      { date: '20/04/2024', description: 'DIVERSO UM', amount: '-100,00', account: 'CC-D' },
      { date: '20/04/2024', description: 'DIVERSO DOIS', amount: '-150,00', account: 'CC-D' },
      { date: '22/04/2024', description: 'MATERIAL', amount: '-99,00', account: 'CC-D' },
      { date: '28/04/2024', description: 'TAXA AVULSA', amount: '-10,00', account: 'CC-D' },
      { date: '25/04/2024', description: 'RECEITA AVULSA', amount: '50,00', account: 'CC-D' },
    ]);
    [d.l1, d.l2, d.l3, d.l4, d.l5, d.l6, d.l7, d.l8] = ledger.map((row) => row.id as string);
  });

  it('1:N sem diferença dispensa observação', async () => {
    const response = await analyst.post('/reconciliation/matches/manual', {
      bankTransactionIds: [d.b1],
      ledgerEntryIds: [d.l1, d.l2],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ type: 'manual', origin: 'user', status: 'confirmed', differenceCents: 0, divergence: null });
    expect(response.body.ledger).toHaveLength(2);
    for (const id of [d.l1, d.l2]) expect(await itemStatus(admin, 'ledger', id)).toBe('reconciled');
    expect(await itemStatus(admin, 'bank', d.b1)).toBe('reconciled');
    expect(await auditCount(admin, 'reconciliation.match_manual', response.body.id)).toBe(1);
  });

  it('1:1 com diferença exige observação', async () => {
    const body = { bankTransactionIds: [d.b2], ledgerEntryIds: [d.l3] };
    const missing = await analyst.post('/reconciliation/matches/manual', body);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('note_required');
    const response = await analyst.post('/reconciliation/matches/manual', { ...body, note: 'Diferença de tarifa do depósito' });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'confirmed', differenceCents: 1000, divergence: 'amount' });
    expect(response.body.proposalNote).toBe('Diferença de tarifa do depósito');
  });

  it('1:N com diferença e 1:1 sem diferença', async () => {
    const withDifference = await analyst.post('/reconciliation/matches/manual', {
      bankTransactionIds: [d.b3],
      ledgerEntryIds: [d.l4, d.l5],
      note: 'Juros pagos à parte',
    });
    expect(withDifference.status).toBe(201);
    expect(withDifference.body.differenceCents).toBe(-5000);
    const exact = await analyst.post('/reconciliation/matches/manual', { bankTransactionIds: [d.b4], ledgerEntryIds: [d.l6] });
    expect(exact.status).toBe(201);
    expect(exact.body.differenceCents).toBe(0);
  });

  it('recusa item já conciliado, sinais diferentes e lado vazio', async () => {
    const taken = await analyst.post('/reconciliation/matches/manual', { bankTransactionIds: [d.b1], ledgerEntryIds: [d.l7] });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('already_reconciled');
    const signs = await analyst.post('/reconciliation/matches/manual', { bankTransactionIds: [d.b5], ledgerEntryIds: [d.l8] });
    expect(signs.status).toBe(400);
    expect(signs.body.error.code).toBe('sign_mismatch');
    const empty = await analyst.post('/reconciliation/matches/manual', { bankTransactionIds: [d.b5], ledgerEntryIds: [] });
    expect(empty.status).toBe(400);
    const auditor = await userWithRole(app, admin, 'auditor');
    expect((await auditor.post('/reconciliation/matches/manual', { bankTransactionIds: [d.b5], ledgerEntryIds: [d.l7] })).status).toBe(403);
    expect((await auditor.get(`/reconciliation/items?bankAccountId=${accountD.id}`)).status).toBe(200);
  });

  it('ignora itens dos dois lados com justificativa', async () => {
    expect((await analyst.post('/reconciliation/items/ignore', { side: 'bank', id: d.b5 })).status).toBe(400);
    const bank = await analyst.post('/reconciliation/items/ignore', { side: 'bank', id: d.b5, reason: 'Lançado em outro sistema' });
    expect(bank.status).toBe(201);
    expect(bank.body).toMatchObject({ type: 'ignored', status: 'confirmed', decisionNote: 'Lançado em outro sistema' });
    expect(await itemStatus(admin, 'bank', d.b5)).toBe('ignored');
    const ledger = await analyst.post('/reconciliation/items/ignore', { side: 'ledger', id: d.l7, reason: 'Lançamento cancelado' });
    expect(ledger.status).toBe(201);
    expect(await itemStatus(admin, 'ledger', d.l7)).toBe('ignored');
    const again = await analyst.post('/reconciliation/items/ignore', { side: 'ledger', id: d.l7, reason: 'de novo' });
    expect(again.status).toBe(409);
    expect(await auditCount(admin, 'reconciliation.item_ignored', bank.body.id)).toBe(1);
  });

  it('classifica transação sem lançamento com uma categoria', async () => {
    const categories = await admin.get('/categories');
    const category = categories.body.items[0];
    const response = await analyst.post('/reconciliation/items/classify', {
      bankTransactionId: d.b6,
      categoryId: category.id,
      note: 'Serviço eventual',
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ type: 'classification', status: 'confirmed', categoryId: category.id });
    const detail = await admin.get(`/reconciliation/items/bank/${d.b6}`);
    expect(detail.body.item).toMatchObject({ status: 'reconciled', categoryId: category.id });
    const invalid = await analyst.post('/reconciliation/items/classify', {
      bankTransactionId: d.b6,
      categoryId: '00000000-0000-4000-8000-000000000000',
    });
    expect(invalid.status).toBe(400);
  });

  it('painel com contagens e somas corretas por situação, conta e taxa de conciliação automática', async () => {
    const response = await admin.get(`/dashboard?bankAccountId=${accountD.id}&dateFrom=2024-04-01&dateTo=2024-04-30`);
    expect(response.status).toBe(200);
    const dash = response.body;
    expect(dash.bank.reconciled).toEqual({ count: 5, amountCents: -95900, creditsCents: 70000, debitsCents: -165900 });
    expect(dash.bank.ignored).toEqual({ count: 1, amountCents: -4500, creditsCents: 0, debitsCents: -4500 });
    expect(dash.bank.pending).toEqual({ count: 0, amountCents: 0, creditsCents: 0, debitsCents: 0 });
    expect(dash.bank.total).toMatchObject({ count: 6, amountCents: -100400 });
    expect(dash.ledger.reconciled).toMatchObject({ count: 6, amountCents: -85900 });
    expect(dash.ledger.ignored).toMatchObject({ count: 1, amountCents: -1000 });
    expect(dash.ledger.pending).toMatchObject({ count: 1, amountCents: 5000 });
    expect(dash).toMatchObject({ openSuggestions: 0, pendingApprovals: 0 });
    expect(dash.autoReconciliation).toEqual({ reconciled: 5, auto: 0, rate: 0 });
    expect(dash.byAccount).toHaveLength(1);
    expect(dash.byAccount[0]).toMatchObject({ bankAccountId: accountD.id, name: 'Conta D' });
    expect(dash.byAccount[0].bank.reconciled.count).toBe(5);
    expect(dash.lastImport).toMatchObject({ status: 'completed' });
    expect(dash.lastRun).toBeNull();

    const janA = await admin.get(`/dashboard?bankAccountId=${accountA.id}&dateFrom=2024-01-01&dateTo=2024-01-31`);
    // b4 classificado por pessoa; b1 desfeito; b2 desfeito; b3 pendente.
    expect(janA.body.bank.reconciled.count).toBe(1);
    expect(janA.body.bank.pending.count).toBe(3);
    expect(janA.body.lastRun).toMatchObject({ bankAccountId: accountA.id, status: 'completed' });

    const all = await admin.get('/dashboard');
    const suggested = await admin.get('/reconciliation/matches?status=suggested&limit=200');
    expect(all.body.openSuggestions).toBe(suggested.body.items.length);
    expect(all.body.byAccount.length).toBeGreaterThanOrEqual(4);
  });
});

describe('CA-21: tolerância de data configurável', () => {
  it('alterar a tolerância muda o resultado da execução seguinte', async () => {
    const own = await createTenant({ label: 'tolerancia' });
    const client = await loggedIn(app, own.adminEmail);
    const account = await createBankAccount(own.tenantId, { name: 'Conta E', accountNumber: '55555-5', externalRef: 'CC-E' });
    const [bank] = await importStatement(app, client, account, [{ date: '2024-03-10', amount: '-500.00', memo: 'PAGAMENTO ALUGUEL' }]);
    const [ledger] = await importLedger(app, client, [
      { date: '14/03/2024', description: 'ALUGUEL MARCO', amount: '-500,00', account: 'CC-E' },
    ]);

    const first = await runReconciliation(app, client, account.id, '2024-03-01', '2024-03-31');
    expect(first.stats.autoMatched).toBe(0);
    expect(await matchesWith(client, bank.id)).toHaveLength(0);
    expect(await itemStatus(client, 'bank', bank.id)).toBe('pending');

    const saved = await client.put('/settings', { patch: { reconciliation: { dateToleranceDays: 5 } } });
    expect(saved.status).toBe(200);
    const second = await runReconciliation(app, client, account.id, '2024-03-01', '2024-03-31');
    expect(second.rulesSnapshot.dateToleranceDays).toBe(5);
    expect(second.stats.autoMatched).toBe(1);
    const [match] = await matchesWith(client, bank.id);
    expect(match).toMatchObject({ status: 'confirmed', autoConfirmed: true, ruleCode: 'VALOR_DATA_UNICO', dateDiffDays: 4 });
    expect(await itemStatus(client, 'ledger', ledger.id)).toBe('reconciled');
    // A execução anterior guarda as regras da época.
    expect((await client.get(`/reconciliation/runs/${first.id}`)).body.rulesSnapshot.dateToleranceDays).toBe(2);
  });
});

describe('CA-12: aprovação em duas etapas', () => {
  let own: TestTenant;
  let ownAdmin: ApiClient;
  let manager: ApiClient & { userId: string };
  let secondManager: ApiClient & { userId: string };
  let ownAnalyst: ApiClient & { userId: string };
  let account: TestBankAccount;
  const f: Record<string, string> = {};

  beforeAll(async () => {
    own = await createTenant({ label: 'aprovacao' });
    ownAdmin = await loggedIn(app, own.adminEmail);
    manager = await userWithRole(app, ownAdmin, 'gestor');
    secondManager = await userWithRole(app, ownAdmin, 'gestor');
    ownAnalyst = await userWithRole(app, ownAdmin, 'analista');
    account = await createBankAccount(own.tenantId, { name: 'Conta F', accountNumber: '66666-6', externalRef: 'CC-F' });
    const bank = await importStatement(app, ownAdmin, account, [
      { date: '2024-05-02', amount: '-800.00', memo: 'PAGAMENTO SERVICO' },
      { date: '2024-05-06', amount: '-250.00', memo: 'PAGAMENTO MANUTENCAO' },
      { date: '2024-05-10', amount: '1000.00', memo: 'RECEBIMENTO CLIENTE NF 5555' },
    ]);
    [f.b1, f.b2, f.b3] = bank.map((row) => row.id as string);
    const ledger = await importLedger(app, ownAdmin, [
      { date: '02/05/2024', description: 'SERVICO PRESTADO', amount: '-800,00', account: 'CC-F' },
      { date: '06/05/2024', description: 'MANUTENCAO PREDIAL', amount: '-250,00', account: 'CC-F' },
      { date: '10/05/2024', description: 'RECEBIMENTO CLIENTE', document: '5555', amount: '990,00', account: 'CC-F' },
    ]);
    [f.l1, f.l2, f.l3] = ledger.map((row) => row.id as string);
  });

  it('sem o módulo ativo a configuração não pode ser ligada', async () => {
    const refused = await ownAdmin.put('/settings', { patch: { approvals: { enabled: true } } });
    expect(refused.status).toBe(403);
    expect((await ownAdmin.put('/modules/approvals', { enabled: true })).status).toBe(200);
    expect((await ownAdmin.put('/settings', { patch: { approvals: { enabled: true } } })).status).toBe(200);
  });

  it('quem propôs não aprova (403 four_eyes); outro usuário com permissão aprova', async () => {
    const proposed = await manager.post('/reconciliation/matches/manual', {
      bankTransactionIds: [f.b1],
      ledgerEntryIds: [f.l1],
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ status: 'pending_approval', proposedBy: manager.userId });
    expect(await itemStatus(ownAdmin, 'bank', f.b1)).toBe('awaiting_approval');

    const notices = await ownerPool().query(
      `SELECT user_id FROM notifications WHERE tenant_id = $1 AND event = 'approval.requested'`,
      [own.tenantId],
    );
    const notified = notices.rows.map((row) => row.user_id);
    expect(notified).toContain(secondManager.userId);
    expect(notified).not.toContain(manager.userId);
    expect(notified).not.toContain(ownAnalyst.userId);

    const pending = await ownAdmin.get('/reconciliation/matches?status=pending_approval');
    expect(pending.body.items.map((item: { id: string }) => item.id)).toEqual([proposed.body.id]);
    const dash = await ownAdmin.get('/dashboard');
    expect(dash.body.pendingApprovals).toBe(1);
    expect(dash.body.bank.awaitingApproval.count).toBe(1);

    const self = await manager.post(`/reconciliation/matches/${proposed.body.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('four_eyes');
    expect((await ownAnalyst.post(`/reconciliation/matches/${proposed.body.id}/approve`, {})).status).toBe(403);

    const approved = await secondManager.post(`/reconciliation/matches/${proposed.body.id}/approve`, { note: 'Conferido' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'confirmed', decidedBy: secondManager.userId, decisionNote: 'Conferido' });
    expect(await itemStatus(ownAdmin, 'bank', f.b1)).toBe('reconciled');
    expect(await itemStatus(ownAdmin, 'ledger', f.l1)).toBe('reconciled');
    expect(await auditCount(ownAdmin, 'reconciliation.match_approved', proposed.body.id)).toBe(1);

    // CA-14 com aprovação: desfazer devolve os itens a pendente.
    const undone = await secondManager.post(`/reconciliation/matches/${proposed.body.id}/undo`, { reason: 'Revisão do fechamento' });
    expect(undone.status).toBe(200);
    expect(await itemStatus(ownAdmin, 'bank', f.b1)).toBe('pending');
  });

  it('aceitar sugestão divergente vai para aprovação e só concilia ao aprovar', async () => {
    // Só o recebimento com NF entra no período; os demais ficam para as decisões manuais abaixo.
    await runReconciliation(app, ownAdmin, account.id, '2024-05-10', '2024-05-31');
    const [divergent] = await matchesWith(ownAdmin, f.b3, 'status=suggested');
    expect(divergent).toMatchObject({ divergence: 'amount' });
    const accepted = await ownAnalyst.post(`/reconciliation/matches/${divergent.id}/accept`, {});
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('pending_approval');
    expect(await itemStatus(ownAdmin, 'bank', f.b3)).toBe('awaiting_approval');
    const approved = await manager.post(`/reconciliation/matches/${divergent.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(await itemStatus(ownAdmin, 'bank', f.b3)).toBe('reconciled');
  });

  it('recusar a aprovação exige motivo e libera os itens', async () => {
    const proposed = await ownAnalyst.post('/reconciliation/matches/manual', { bankTransactionIds: [f.b2], ledgerEntryIds: [f.l2] });
    expect(proposed.body.status).toBe('pending_approval');
    expect((await manager.post(`/reconciliation/matches/${proposed.body.id}/refuse`, {})).status).toBe(400);
    const refused = await manager.post(`/reconciliation/matches/${proposed.body.id}/refuse`, { reason: 'Falta comprovante' });
    expect(refused.status).toBe(200);
    expect(refused.body.status).toBe('rejected');
    expect(await itemStatus(ownAdmin, 'bank', f.b2)).toBe('pending');
    expect(await auditCount(ownAdmin, 'reconciliation.match_refused', proposed.body.id)).toBe(1);
  });

  it('com o módulo desligado a regra da empresa não vale e a decisão confirma direto', async () => {
    expect((await ownAdmin.put('/modules/approvals', { enabled: false })).status).toBe(200);
    const direct = await ownAnalyst.post('/reconciliation/matches/manual', { bankTransactionIds: [f.b2], ledgerEntryIds: [f.l2] });
    expect(direct.status).toBe(201);
    expect(direct.body.status).toBe('confirmed');
  });
});

describe('isolamento entre empresas', () => {
  it('outra empresa não vê nem decide sobre itens, conciliações e execuções', async () => {
    const [match] = await matchesWith(admin, jan.b3);
    const fake = { reason: 'tentativa', note: 'tentativa' };

    expect((await otherAdmin.get(`/reconciliation/runs/${janRunId}`)).status).toBe(404);
    expect((await otherAdmin.get(`/reconciliation/items/bank/${jan.b3}`)).status).toBe(404);
    expect((await otherAdmin.get(`/reconciliation/items/ledger/${jan.l4}`)).status).toBe(404);
    expect((await otherAdmin.get(`/reconciliation/matches/${match.id}`)).status).toBe(404);
    for (const action of ['accept', 'reject', 'approve', 'refuse', 'undo']) {
      const response = await otherAdmin.post(`/reconciliation/matches/${match.id}/${action}`, fake);
      expect(response.status, action).toBe(404);
    }
    const manual = await otherAdmin.post('/reconciliation/matches/manual', {
      bankTransactionIds: [jan.b3],
      ledgerEntryIds: [jan.l4],
      note: 'x',
    });
    expect(manual.status).toBe(404);
    expect((await otherAdmin.post('/reconciliation/items/ignore', { side: 'bank', id: jan.b3, reason: 'x' })).status).toBe(404);
    const categories = await otherAdmin.get('/categories');
    const classify = await otherAdmin.post('/reconciliation/items/classify', {
      bankTransactionId: jan.b3,
      categoryId: categories.body.items[0].id,
    });
    expect(classify.status).toBe(404);
    const bulk = await otherAdmin.post('/reconciliation/matches/bulk-accept', { ids: [match.id] });
    expect(bulk.body.results[0]).toMatchObject({ ok: false, error: { code: 'not_found' } });
    const run = await otherAdmin.post('/reconciliation/runs', {
      bankAccountId: accountA.id,
      periodStart: '2024-01-01',
      periodEnd: '2024-01-31',
    });
    expect(run.status).toBe(404);
    await drainJobs(app);

    expect((await otherAdmin.get('/reconciliation/items')).body.items).toEqual([]);
    expect((await otherAdmin.get('/reconciliation/matches')).body.items).toEqual([]);
    expect((await otherAdmin.get('/reconciliation/runs')).body.items).toEqual([]);
    const dash = await otherAdmin.get('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body).toMatchObject({ openSuggestions: 0, pendingApprovals: 0, lastImport: null, lastRun: null, byAccount: [] });
    expect(dash.body.bank.total.count).toBe(0);

    // Nada mudou na empresa dona
    expect((await admin.get(`/reconciliation/matches/${match.id}`)).body.status).toBe('rejected');
  });
});
