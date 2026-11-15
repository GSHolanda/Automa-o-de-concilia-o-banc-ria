import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getJobHandler, registerJobHandler } from '../../src/jobs/registry';
import { ApiClient, buildTestApp, createTenant, loggedIn, userWithRole, type TestTenant } from '../helpers/app';
import { asTenant, closePools, ownerPool } from '../helpers/db';
import {
  bankTransactionsOf,
  buildCsv,
  buildOfx,
  buildXlsx,
  createBankAccount,
  createImportProfile,
  drainJobs,
  importFile,
  ledgerEntriesOf,
  makeJobsDue,
  uploadImport,
  type TestBankAccount,
} from '../helpers/imports';

let app: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;
let admin: ApiClient;
let otherAdmin: ApiClient;
let account: TestBankAccount;

/** Extrato de janeiro usado em vários testes. */
const JANUARY = [
  { date: '2024-01-05', amount: '1500.00', memo: 'PIX RECEBIDO PADARIA BOM PÃO NF 4512', fitId: 'F1', checkNum: '004512' },
  { date: '2024-01-08', amount: '-35,90', memo: 'TARIFA PACOTE SERVIÇOS', fitId: 'F2' },
  // Débito enviado com valor positivo: o tipo DEBIT define o sinal.
  { date: '2024-01-10', amount: '250.00', type: 'DEBIT', name: 'FORNECEDOR ALFA', memo: 'PAGTO TITULO', fitId: 'F3' },
];

async function countBank(accountId: string): Promise<number> {
  const result = await ownerPool().query('SELECT count(*)::int AS total FROM bank_transactions WHERE bank_account_id = $1', [
    accountId,
  ]);
  return result.rows[0].total;
}

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'importa' });
  other = await createTenant({ label: 'importa-outra' });
  admin = await loggedIn(app, tenant.adminEmail);
  otherAdmin = await loggedIn(app, other.adminEmail);
  account = await createBankAccount(tenant.tenantId, { name: 'Conta Movimento', accountNumber: '56789-0' });
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('OFX (CA-01)', () => {
  let batchId: string;

  it('importa OFX em Windows-1252, sem tags de fechamento, com datas, valores e sinais corretos', async () => {
    const content = buildOfx({ accountId: '00056789-0', transactions: JANUARY });
    expect(content.includes(Buffer.from('PÃO', 'utf8'))).toBe(false); // bytes em Windows-1252, não UTF-8

    const upload = await uploadImport(admin, { sourceKind: 'bank', bankAccountId: account.id, fileName: 'janeiro.ofx', content });
    expect(upload.status).toBe(201);
    expect(upload.body.fileFormat).toBe('ofx');
    expect(upload.body.preview).toMatchObject({
      accountMatches: true,
      transactionCount: 3,
      period: { start: '2024-01-05', end: '2024-01-10' },
      account: { accountId: '00056789-0' },
    });
    expect(upload.body.preview.sample[0]).toMatchObject({ date: '2024-01-05', amountCents: 150000 });
    batchId = upload.body.id;

    const confirmed = await admin.post(`/imports/${batchId}/confirm`, {});
    expect(confirmed.status).toBe(202);
    expect(confirmed.body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await admin.get(`/imports/${batchId}`)).body.status).toBe('queued');

    await drainJobs(app);
    const batch = await admin.get(`/imports/${batchId}`);
    expect(batch.body).toMatchObject({ status: 'completed', error: null, fileSha256: upload.body.sha256 });
    expect(batch.body.stats).toEqual({
      totalRows: 3,
      imported: 3,
      duplicates: 0,
      rejected: 0,
      conflicts: 0,
      skipped: 0,
      duplicateSuspects: 0,
      periodStart: '2024-01-05',
      periodEnd: '2024-01-10',
    });
    expect(batch.body.job).toMatchObject({ status: 'succeeded', attempts: 1 });

    const rows = await bankTransactionsOf(batchId);
    expect(rows.map((row) => [row.posted_date, row.amount_cents])).toEqual([
      ['2024-01-05', 150000],
      ['2024-01-08', -3590],
      ['2024-01-10', -25000],
    ]);
    expect(rows[0].description_raw).toBe('PIX RECEBIDO PADARIA BOM PÃO NF 4512');
    expect(rows[0].description_norm).toBe('PIX RECEBIDO PADARIA BOM PAO NF 4512');
    expect(rows[0].identifiers).toContain('4512');
    expect(rows[2].description_raw).toBe('FORNECEDOR ALFA PAGTO TITULO');
    // Tarifa reconhecida pelas regras padrão da empresa.
    expect(rows.map((row) => row.kind)).toEqual(['regular', 'fee', 'regular']);
    expect(rows[1].kind_rule).toBeTruthy();

    const audit = await admin.get(`/audit?action=import.processed&entityId=${batchId}`);
    expect(audit.body.items).toHaveLength(1);
  });

  it('preserva o arquivo original e audita o download', async () => {
    const download = await admin.get(`/imports/${batchId}/file`);
    expect(download.status).toBe(200);
    expect(download.raw.equals(buildOfx({ accountId: '00056789-0', transactions: JANUARY }))).toBe(true);
    const audit = await admin.get(`/audit?action=import.file_downloaded&entityId=${batchId}`);
    expect(audit.body.items).toHaveLength(1);
  });

  it('reenviar o mesmo arquivo responde 409 com o lote existente (CA-04)', async () => {
    const again = await uploadImport(admin, {
      sourceKind: 'bank',
      bankAccountId: account.id,
      fileName: 'janeiro-copia.ofx',
      content: buildOfx({ accountId: '00056789-0', transactions: JANUARY }),
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('duplicate_file');
    expect(again.body.error.details.batchId).toBe(batchId);
  });

  it('arquivo com período sobreposto importa apenas as transações novas (CA-04)', async () => {
    const before = await countBank(account.id);
    const { batch } = await importFile(app, admin, {
      sourceKind: 'bank',
      bankAccountId: account.id,
      fileName: 'janeiro-2.ofx',
      content: buildOfx({
        accountId: '00056789-0',
        transactions: [
          JANUARY[2]!,
          { date: '2024-01-15', amount: '-89,90', memo: 'COMPRA CARTAO MERCADO', fitId: 'F4' },
          { date: '2024-01-20', amount: '320,00', memo: 'PIX RECEBIDO CLIENTE BETA', fitId: 'F5' },
        ],
      }),
    });
    expect(batch.status).toBe('completed');
    expect(batch.stats).toMatchObject({ totalRows: 3, imported: 2, duplicates: 1, duplicateSuspects: 0 });
    expect(await countBank(account.id)).toBe(before + 2);
  });

  it('transação igual com identificador diferente entra sinalizada como possível duplicidade', async () => {
    const original = (await bankTransactionsOf(batchId))[0];
    const { batchId: suspectBatch, batch } = await importFile(app, admin, {
      sourceKind: 'bank',
      bankAccountId: account.id,
      fileName: 'janeiro-banco-novo-id.ofx',
      content: buildOfx({ accountId: '00056789-0', transactions: [{ ...JANUARY[0]!, fitId: 'OUTRO-ID-1' }] }),
    });
    expect(batch.stats).toMatchObject({ imported: 1, duplicates: 0, duplicateSuspects: 1 });
    const [row] = await bankTransactionsOf(suspectBatch);
    expect(row).toMatchObject({ duplicate_suspect: true, recon_status: 'divergent', amount_cents: 150000 });

    const match = await ownerPool().query(
      `SELECT m.match_type, m.status, m.origin, m.divergence, m.breakdown, i.side, i.active
         FROM matches m JOIN match_items i ON i.match_id = m.id
        WHERE i.bank_transaction_id = $1`,
      [row.id],
    );
    expect(match.rows).toHaveLength(1);
    expect(match.rows[0]).toMatchObject({
      match_type: 'ignored',
      status: 'suggested',
      origin: 'engine',
      divergence: 'duplicate',
      side: 'bank',
      active: false,
    });
    expect(match.rows[0].breakdown.duplicateOf).toBe(original.id);
    // O registro original não é tocado.
    expect((await bankTransactionsOf(batchId))[0]).toMatchObject({ duplicate_suspect: false, recon_status: 'pending' });
  });

  it('conta do OFX diferente da selecionada: o lote falha, sem repetir; reprocessar permitindo a divergência importa', async () => {
    const second = await createBankAccount(tenant.tenantId, { name: 'Conta Aplicação', accountNumber: '11111-1' });
    const content = buildOfx({
      accountId: '99999-9',
      transactions: [{ date: '2024-02-01', amount: '10,00', memo: 'RENDIMENTO', fitId: 'R1' }],
    });
    const upload = await uploadImport(admin, { sourceKind: 'bank', bankAccountId: second.id, fileName: 'outra.ofx', content });
    expect(upload.status).toBe(201);
    expect(upload.body.preview.accountMatches).toBe(false);

    await admin.post(`/imports/${upload.body.id}/confirm`, {});
    const summary = await drainJobs(app);
    expect(summary).toMatchObject({ succeeded: 1, retried: 0, dead: 0 });
    const failed = await admin.get(`/imports/${upload.body.id}`);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.error).toMatch(/não corresponde à conta selecionada/);
    expect(failed.body.job.status).toBe('succeeded');
    expect(await countBank(second.id)).toBe(0);

    const reprocess = await admin.post(`/imports/${upload.body.id}/reprocess`, { allowAccountMismatch: true });
    expect(reprocess.status).toBe(202);
    expect(reprocess.body.jobId).toBe(failed.body.job.id);
    await drainJobs(app);
    const done = await admin.get(`/imports/${upload.body.id}`);
    expect(done.body.status).toBe('completed');
    expect(await countBank(second.id)).toBe(1);
  });
});

describe('CSV e XLSX', () => {
  it('CSV com ";", valores 1.234,56 e colunas débito/crédito, conforme o perfil (CA-02)', async () => {
    const csvAccount = await createBankAccount(tenant.tenantId, { name: 'Conta CSV' });
    const profile = await createImportProfile(tenant.tenantId, {
      sourceKind: 'bank',
      fileFormat: 'csv',
      config: {
        delimiter: ';',
        encoding: 'windows-1252',
        headerRow: 1,
        dateFormat: 'DD/MM/YYYY',
        decimalSeparator: ',',
        amountMode: 'debit_credit',
        columns: { date: 'Data', description: ['Histórico'], document: 'Documento', debit: 'Débito', credit: 'Crédito' },
      },
    });
    const content = buildCsv([
      ['Data', 'Histórico', 'Documento', 'Débito', 'Crédito'],
      ['02/02/2024', 'SALDO ANTERIOR', '', '', ''],
      ['05/02/2024', 'RECEBIMENTO CLIENTE ÔMEGA', '123', '', '1.234,56'],
      ['06/02/2024', 'PAGAMENTO FORNECEDOR', '456', '50,00', ''],
      ['07/02/2024', 'TARIFA MANUTENÇÃO', '', '12,90', ''],
    ]);
    const upload = await uploadImport(admin, {
      sourceKind: 'bank',
      bankAccountId: csvAccount.id,
      profileId: profile.id,
      fileName: 'extrato.csv',
      content,
    });
    expect(upload.status).toBe(201);
    expect(upload.body.fileFormat).toBe('csv');
    expect(upload.body.preview).toMatchObject({ delimiter: ';', headerRow: 1, encoding: 'windows-1252' });
    expect(upload.body.preview.headers).toEqual(['Data', 'Histórico', 'Documento', 'Débito', 'Crédito']);
    expect(upload.body.preview.suggestion.amountMode).toBe('debit_credit');

    const confirmed = await admin.post(`/imports/${upload.body.id}/confirm`, {});
    expect(confirmed.status).toBe(202);
    await drainJobs(app);
    const batch = await admin.get(`/imports/${upload.body.id}`);
    expect(batch.body.status).toBe('completed');
    expect(batch.body.profileId).toBe(profile.id);
    expect(batch.body.stats).toMatchObject({ totalRows: 4, imported: 3, skipped: 1, rejected: 0 });

    const rows = await bankTransactionsOf(upload.body.id);
    expect(rows.map((row) => [row.posted_date, row.amount_cents, row.description_raw])).toEqual([
      ['2024-02-05', 123456, 'RECEBIMENTO CLIENTE ÔMEGA'],
      ['2024-02-06', -5000, 'PAGAMENTO FORNECEDOR'],
      ['2024-02-07', -1290, 'TARIFA MANUTENÇÃO'],
    ]);
    expect(rows[0].document).toBe('123');
    expect(rows[2].kind).toBe('fee');
  });

  it('XLSX com datas nativas e valores numéricos, com mapeamento salvo como perfil (CA-03)', async () => {
    const xlsxAccount = await createBankAccount(tenant.tenantId, { name: 'Conta XLSX' });
    const content = await buildXlsx(
      [
        ['Data', 'Descrição', 'Valor'],
        [new Date(Date.UTC(2024, 2, 1)), 'DEPOSITO EM DINHEIRO', 980.5],
        [new Date(Date.UTC(2024, 2, 4)), 'PAGAMENTO ALUGUEL', -2500],
        [new Date(Date.UTC(2024, 2, 29)), 'PIX RECEBIDO CLIENTE GAMA', 1234.56],
      ],
      'Extrato',
    );
    const upload = await uploadImport(admin, { sourceKind: 'bank', bankAccountId: xlsxAccount.id, fileName: 'extrato.xlsx', content });
    expect(upload.status).toBe(201);
    expect(upload.body.fileFormat).toBe('xlsx');
    expect(upload.body.preview).toMatchObject({ sheetNames: ['Extrato'], headerRow: 1, headers: ['Data', 'Descrição', 'Valor'] });
    expect(upload.body.preview.sampleRows[0]).toEqual(['2024-03-01', 'DEPOSITO EM DINHEIRO', 980.5]);
    expect(upload.body.preview.suggestion.columns).toMatchObject({ date: 'Data', description: ['Descrição'], amount: 'Valor' });

    const preview = await admin.get(`/imports/${upload.body.id}/preview?sheetName=Extrato`);
    expect(preview.status).toBe(200);
    expect((await admin.get(`/imports/${upload.body.id}/preview?sheetName=Inexistente`)).status).toBe(400);

    const confirmed = await admin.post(`/imports/${upload.body.id}/confirm`, {
      config: { headerRow: 1, amountMode: 'signed', columns: { date: 'Data', description: ['Descrição'], amount: 'Valor' } },
      saveProfileAs: 'Planilha do banco fictício',
    });
    expect(confirmed.status).toBe(202);
    await drainJobs(app);

    const batch = await admin.get(`/imports/${upload.body.id}`);
    expect(batch.body.status).toBe('completed');
    expect(batch.body.config.mapping.columns.amount).toBe('Valor');
    const saved = await asTenant(tenant.tenantId, (db) =>
      db.query('SELECT id, source_kind, file_format FROM import_profiles WHERE name = $1', ['Planilha do banco fictício']),
    );
    expect(saved.rows[0]).toMatchObject({ id: batch.body.profileId, source_kind: 'bank', file_format: 'xlsx' });

    const rows = await bankTransactionsOf(upload.body.id);
    expect(rows.map((row) => [row.posted_date, row.amount_cents])).toEqual([
      ['2024-03-01', 98050],
      ['2024-03-04', -250000],
      ['2024-03-29', 123456],
    ]);
  });

  it('linha com data inválida é rejeitada com motivo e as demais entram (CA-05)', async () => {
    const csvAccount = await createBankAccount(tenant.tenantId, { name: 'Conta CA-05' });
    const { batchId, batch } = await importFile(
      app,
      admin,
      {
        sourceKind: 'bank',
        bankAccountId: csvAccount.id,
        fileName: 'com-erro.csv',
        content: buildCsv([
          ['Data', 'Descrição', 'Valor'],
          ['01/04/2024', 'PIX RECEBIDO CLIENTE DELTA', '100,00'],
          ['31/02/2024', 'LINHA COM DATA INEXISTENTE', '50,00'],
          ['03/04/2024', 'PAGAMENTO LUZ', '-75,10'],
        ]),
      },
      { config: { columns: { date: 'Data', description: ['Descrição'], amount: 'Valor' } } },
    );
    expect(batch.status).toBe('completed_with_errors');
    expect(batch.stats).toMatchObject({ totalRows: 3, imported: 2, rejected: 1 });
    const rejections = await admin.get(`/imports/${batchId}/rejections`);
    expect(rejections.status).toBe(200);
    expect(rejections.body.items).toHaveLength(1);
    expect(rejections.body.items[0]).toMatchObject({ rowNumber: 3, kind: 'invalid' });
    expect(rejections.body.items[0].reason).toMatch(/Data inválida/);
    expect(rejections.body.items[0].raw).toMatchObject({ Descrição: 'LINHA COM DATA INEXISTENTE' });
    expect((await bankTransactionsOf(batchId)).map((row) => row.amount_cents)).toEqual([10000, -7510]);
  });

  it('linhas idênticas legítimas no mesmo arquivo entram as duas; em reimportação sobreposta, nenhuma se repete', async () => {
    const sameAccount = await createBankAccount(tenant.tenantId, { name: 'Conta Vendas' });
    const config = { config: { columns: { date: 'Data', description: ['Descrição'], amount: 'Valor' } } };
    const sale = ['10/05/2024', 'VENDA CARTAO DEBITO', '45,00'];
    const first = await importFile(
      app,
      admin,
      {
        sourceKind: 'bank',
        bankAccountId: sameAccount.id,
        fileName: 'vendas-1.csv',
        content: buildCsv([['Data', 'Descrição', 'Valor'], sale, sale]),
      },
      config,
    );
    expect(first.batch.stats).toMatchObject({ imported: 2, duplicates: 0, duplicateSuspects: 0 });

    const second = await importFile(
      app,
      admin,
      {
        sourceKind: 'bank',
        bankAccountId: sameAccount.id,
        fileName: 'vendas-2.csv',
        content: buildCsv([['Data', 'Descrição', 'Valor'], sale, sale, ['11/05/2024', 'VENDA CARTAO CREDITO', '90,00']]),
      },
      config,
    );
    expect(second.batch.stats).toMatchObject({ imported: 1, duplicates: 2, duplicateSuspects: 0 });
    expect(await countBank(sameAccount.id)).toBe(3);
  });

  it('confirmação de CSV exige perfil ou mapeamento válido', async () => {
    const csvAccount = await createBankAccount(tenant.tenantId, { name: 'Conta Validação' });
    const upload = await uploadImport(admin, {
      sourceKind: 'bank',
      bankAccountId: csvAccount.id,
      fileName: 'sem-perfil.csv',
      content: buildCsv([['Data', 'Descrição', 'Valor'], ['01/06/2024', 'X', '1,00']]),
    });
    const missing = await admin.post(`/imports/${upload.body.id}/confirm`, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('config_required');
    const invalid = await admin.post(`/imports/${upload.body.id}/confirm`, { config: { amountMode: 'signed', columns: {} } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('validation_error');

    // Coluna inexistente no arquivo: o lote falha com a mensagem do mapeamento, sem repetir o trabalho.
    await admin.post(`/imports/${upload.body.id}/confirm`, {
      config: { columns: { date: 'Data', description: ['Descrição'], amount: 'Montante' } },
    });
    expect((await drainJobs(app)).succeeded).toBe(1);
    const batch = await admin.get(`/imports/${upload.body.id}`);
    expect(batch.body.status).toBe('failed');
    expect(batch.body.error).toMatch(/Montante/);
  });
});

describe('lançamentos do sistema financeiro', () => {
  it('external_id existente com conteúdo diferente vira conflito e não sobrescreve; igual é duplicado', async () => {
    const ledgerAccount = await createBankAccount(tenant.tenantId, { name: 'Conta Pagamentos', externalRef: 'CC-PAG' });
    const config = {
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
    const header = ['ID', 'Data', 'Descrição', 'Documento', 'Valor', 'Conta'];

    const first = await importFile(
      app,
      admin,
      {
        sourceKind: 'ledger',
        fileName: 'lancamentos-1.csv',
        content: buildCsv([
          header,
          ['L1', '05/01/2024', 'RECEBIMENTO PADARIA BOM PÃO', 'NF 4512', '1.500,00', 'CC-PAG'],
          ['L2', '08/01/2024', 'PAGAMENTO FORNECEDOR ALFA', '', '-250,00', 'CC-PAG'],
        ]),
      },
      config,
    );
    expect(first.batch).toMatchObject({ status: 'completed', bankAccountId: null });
    expect(first.batch.stats).toMatchObject({ imported: 2, conflicts: 0 });
    const entries = await ledgerEntriesOf(first.batchId);
    expect(entries.map((entry) => [entry.external_id, entry.amount_cents, entry.bank_account_id])).toEqual([
      ['L1', 150000, ledgerAccount.id],
      ['L2', -25000, ledgerAccount.id],
    ]);

    const second = await importFile(
      app,
      admin,
      {
        sourceKind: 'ledger',
        fileName: 'lancamentos-2.csv',
        content: buildCsv([
          header,
          ['L1', '05/01/2024', 'RECEBIMENTO PADARIA BOM PÃO', 'NF 4512', '1.600,00', 'CC-PAG'],
          ['L3', '12/01/2024', 'PAGAMENTO ENERGIA', '', '-310,00', 'CC-PAG'],
        ]),
      },
      config,
    );
    expect(second.batch.status).toBe('completed_with_errors');
    expect(second.batch.stats).toMatchObject({ imported: 1, conflicts: 1, duplicates: 0 });
    const conflicts = await admin.get(`/imports/${second.batchId}/rejections?kind=conflict`);
    expect(conflicts.body.items).toHaveLength(1);
    expect(conflicts.body.items[0]).toMatchObject({ rowNumber: 2, kind: 'conflict' });
    expect(conflicts.body.items[0].reason).toMatch(/L1/);
    const l1 = await ownerPool().query(
      `SELECT amount_cents::int AS amount_cents FROM ledger_entries WHERE tenant_id = $1 AND external_id = 'L1'`,
      [tenant.tenantId],
    );
    expect(l1.rows).toEqual([{ amount_cents: 150000 }]);

    const third = await importFile(
      app,
      admin,
      {
        sourceKind: 'ledger',
        fileName: 'lancamentos-3.csv',
        content: buildCsv([
          header,
          ['L1', '05/01/2024', 'RECEBIMENTO PADARIA BOM PÃO', 'NF 4512', '1.500,00', 'CC-PAG'],
          ['L4', '15/01/2024', 'PAGAMENTO ALUGUEL', '', '-2.000,00', ''],
        ]),
      },
      config,
    );
    expect(third.batch.stats).toMatchObject({ imported: 1, duplicates: 1, conflicts: 0 });
    expect((await ledgerEntriesOf(third.batchId))[0]).toMatchObject({ external_id: 'L4', bank_account_id: null });
  });
});

describe('falha até virar morto e reprocessamento (CA-22)', () => {
  it('trabalho de importação morre após as tentativas; repetir e reprocessar não duplicam dados', async () => {
    const deadAccount = await createBankAccount(tenant.tenantId, { name: 'Conta Instável', accountNumber: '77777-7' });
    const original = getJobHandler('import.process')!;
    const restore = registerJobHandler('import.process', {
      ...original,
      run: async () => {
        throw new Error('Banco de dados indisponível (simulado)');
      },
    });
    let batchId: string;
    let jobId: string;
    try {
      const upload = await uploadImport(admin, {
        sourceKind: 'bank',
        bankAccountId: deadAccount.id,
        fileName: 'instavel.ofx',
        content: buildOfx({
          accountId: '77777-7',
          start: '2024-07-01',
          end: '2024-07-31',
          transactions: [
            { date: '2024-07-02', amount: '200,00', memo: 'PIX RECEBIDO CLIENTE EPSILON', fitId: 'S1' },
            { date: '2024-13-40', amount: '10,00', memo: 'DATA INVALIDA', fitId: 'S2' },
            { date: '2024-07-03', amount: '-20,00', memo: 'PAGAMENTO TAXI', fitId: 'S3' },
          ],
        }),
      });
      batchId = upload.body.id;
      jobId = (await admin.post(`/imports/${batchId}/confirm`, {})).body.jobId;
      expect((await drainJobs(app)).retried).toBe(1);
      await makeJobsDue([jobId]);
      expect((await drainJobs(app)).retried).toBe(1);
      await makeJobsDue([jobId]);
      expect((await drainJobs(app)).dead).toBe(1);
    } finally {
      restore();
    }

    const dead = await admin.get(`/imports/${batchId}`);
    expect(dead.body.status).toBe('failed');
    expect(dead.body.error).toMatch(/3 tentativa/);
    expect(dead.body.job).toMatchObject({ status: 'dead', attempts: 3, lastError: 'Banco de dados indisponível (simulado)' });
    expect(await countBank(deadAccount.id)).toBe(0);

    const retried = await admin.post(`/jobs/${jobId}/retry`);
    expect(retried.status).toBe(200);
    expect((await admin.get(`/imports/${batchId}`)).body.status).toBe('queued');
    await drainJobs(app);
    const done = await admin.get(`/imports/${batchId}`);
    expect(done.body.status).toBe('completed_with_errors');
    expect(done.body.stats).toMatchObject({ imported: 2, rejected: 1, duplicates: 0 });
    expect(await countBank(deadAccount.id)).toBe(2);

    const reprocess = await admin.post(`/imports/${batchId}/reprocess`, {});
    expect(reprocess.status).toBe(202);
    expect(reprocess.body.jobId).toBe(jobId);
    expect((await admin.post(`/imports/${batchId}/reprocess`, {})).status).toBe(409);
    await drainJobs(app);
    const again = await admin.get(`/imports/${batchId}`);
    expect(again.body.status).toBe('completed_with_errors');
    expect(again.body.stats).toMatchObject({ imported: 2, rejected: 1, duplicates: 0 });
    expect(await countBank(deadAccount.id)).toBe(2);
    expect((await admin.get(`/imports/${batchId}/rejections`)).body.items).toHaveLength(1);
  });
});

describe('envio: validações, cancelamento e limites', () => {
  it('recusa arquivo vazio, origem sem conta, conta de outra empresa, OFX como lançamentos e corpo não multipart', async () => {
    const empty = await uploadImport(admin, { sourceKind: 'bank', bankAccountId: account.id, fileName: 'vazio.csv', content: Buffer.alloc(0) });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('empty_file');

    const csv = buildCsv([['Data', 'Valor'], ['01/01/2024', '1,00']]);
    const noAccount = await uploadImport(admin, { sourceKind: 'bank', fileName: 'a.csv', content: csv });
    expect(noAccount.body.error.code).toBe('bank_account_required');

    const foreign = await createBankAccount(other.tenantId, { name: 'Conta da Outra' });
    const foreignUpload = await uploadImport(admin, { sourceKind: 'bank', bankAccountId: foreign.id, fileName: 'a.csv', content: csv });
    expect(foreignUpload.status).toBe(400);
    expect(foreignUpload.body.error.code).toBe('invalid_bank_account');

    const ledgerOfx = await uploadImport(admin, {
      sourceKind: 'ledger',
      fileName: 'x.ofx',
      content: buildOfx({ accountId: '1', transactions: JANUARY }),
    });
    expect(ledgerOfx.body.error.code).toBe('unsupported_format');

    const notMultipart = await admin.post('/imports', { sourceKind: 'bank' });
    expect(notMultipart.status).toBe(400);

    const auditor = await userWithRole(app, admin, 'auditor');
    const forbidden = await uploadImport(auditor, { sourceKind: 'bank', bankAccountId: account.id, fileName: 'a.csv', content: csv });
    expect(forbidden.status).toBe(403);
  });

  it('cancela lote não confirmado; o mesmo arquivo pode ser reenviado depois', async () => {
    const content = buildCsv([['Data', 'Descrição', 'Valor'], ['01/08/2024', 'CANCELAR', '1,00']]);
    const upload = await uploadImport(admin, { sourceKind: 'bank', bankAccountId: account.id, fileName: 'c.csv', content });
    const canceled = await admin.post(`/imports/${upload.body.id}/cancel`);
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe('canceled');
    expect((await admin.post(`/imports/${upload.body.id}/confirm`, {})).status).toBe(409);
    expect((await admin.post(`/imports/${upload.body.id}/cancel`)).status).toBe(409);
    const again = await uploadImport(admin, { sourceKind: 'bank', bankAccountId: account.id, fileName: 'c.csv', content });
    expect(again.status).toBe(201);
  });

  it('respeita o tamanho máximo do envio (413) e o limite de linhas por importação', async () => {
    const limited = await buildTestApp({ MAX_UPLOAD_MB: '1', MAX_IMPORT_ROWS: '100' });
    try {
      const client = new ApiClient(limited, admin.session);
      const big = await uploadImport(client, {
        sourceKind: 'bank',
        bankAccountId: account.id,
        fileName: 'grande.csv',
        content: Buffer.alloc(1024 * 1024 + 10, 'a'),
      });
      expect(big.status).toBe(413);

      const rowsAccount = await createBankAccount(tenant.tenantId, { name: 'Conta Muitas Linhas' });
      const rows = Array.from({ length: 101 }, (_, index) => ['01/09/2024', `VENDA ${index}`, '1,00']);
      const { batch } = await importFile(
        limited,
        client,
        {
          sourceKind: 'bank',
          bankAccountId: rowsAccount.id,
          fileName: 'muitas.csv',
          content: buildCsv([['Data', 'Descrição', 'Valor'], ...rows]),
        },
        { config: { columns: { date: 'Data', description: ['Descrição'], amount: 'Valor' } } },
      );
      expect(batch.status).toBe('failed');
      expect(batch.error).toMatch(/limite por importação é 100/);
      expect(await countBank(rowsAccount.id)).toBe(0);
    } finally {
      await limited.close();
    }
  });
});

describe('isolamento entre empresas', () => {
  it('outra empresa recebe 404 no lote e não vê os itens', async () => {
    const list = await admin.get('/imports?limit=200');
    const target = list.body.items.find((item: { status: string; fileName: string }) => item.fileName === 'janeiro.ofx');
    expect(target).toBeTruthy();

    for (const path of ['', '/preview', '/rejections', '/file']) {
      expect((await otherAdmin.get(`/imports/${target.id}${path}`)).status).toBe(404);
    }
    for (const path of ['/confirm', '/cancel', '/reprocess']) {
      expect((await otherAdmin.post(`/imports/${target.id}${path}`, {})).status).toBe(404);
    }
    const theirs = await otherAdmin.get('/imports?limit=200');
    expect(theirs.body.items.some((item: { id: string }) => item.id === target.id)).toBe(false);
    const theirJobs = await otherAdmin.get('/jobs?limit=200');
    expect(theirJobs.body.items.some((item: { id: string }) => item.id === target.job.id)).toBe(false);

    const count = (tenantId: string) =>
      asTenant(tenantId, (db) =>
        db.query<{ total: number }>('SELECT count(*)::int AS total FROM bank_transactions WHERE batch_id = $1', [target.id]),
      );
    expect((await count(tenant.tenantId)).rows[0]!.total).toBe(3);
    expect((await count(other.tenantId)).rows[0]!.total).toBe(0);
  });

  it('lista com filtros e paginação', async () => {
    const page = await admin.get('/imports?limit=2&sourceKind=bank');
    expect(page.body.items).toHaveLength(2);
    expect(page.body.nextCursor).toBeTruthy();
    const next = await admin.get(`/imports?limit=2&sourceKind=bank&cursor=${page.body.nextCursor}`);
    expect(next.body.items).toHaveLength(2);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
    const ledger = await admin.get('/imports?sourceKind=ledger');
    expect(ledger.body.items.every((item: { sourceKind: string }) => item.sourceKind === 'ledger')).toBe(true);
  });
});
