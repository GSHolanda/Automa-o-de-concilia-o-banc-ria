import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '@concilia/core';
import { ApiClient, buildTestApp, createTenant, loggedIn, userWithRole, type TestTenant } from '../helpers/app';
import { closePools, ownerPool } from '../helpers/db';
import { createBankAccount, type TestBankAccount } from '../helpers/imports';
import { importLedger, importStatement, runReconciliation } from '../helpers/reconciliation';
import { exportLimits } from '../../src/modules/exports/data';
import { neutralizeFormula } from '../../src/modules/exports/csv';

let app: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;
let admin: ApiClient;
let otherAdmin: ApiClient;
let account: TestBankAccount;
let otherAccount: TestBankAccount;
let bank: any[];

const JAN = { dateFrom: '2024-01-01', dateTo: '2024-01-31' };

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'exporta' });
  other = await createTenant({ label: 'exporta-outra' });
  admin = await loggedIn(app, tenant.adminEmail);
  otherAdmin = await loggedIn(app, other.adminEmail);
  account = await createBankAccount(tenant.tenantId, { name: 'Conta A', accountNumber: '11111-1', externalRef: 'CC-A' });
  otherAccount = await createBankAccount(other.tenantId, { name: 'Conta Z', accountNumber: '99999-9', externalRef: 'CC-Z' });

  bank = await importStatement(app, admin, account, [
    { date: '2024-01-05', amount: '1500.00', memo: 'PIX RECEBIDO CLIENTE ALFA NF 4512' },
    { date: '2024-01-10', amount: '-320.00', memo: 'PAGAMENTO BOLETO' },
    { date: '2024-01-12', amount: '980.00', memo: '=SOMA(1;2) PIX BETA' },
    { date: '2024-01-15', amount: '-35.90', memo: 'TARIFA PACOTE SERVICOS' },
    { date: '2024-02-03', amount: '200.00', memo: 'RECEBIMENTO FEVEREIRO' },
  ]);
  await importLedger(app, admin, [
    { date: '05/01/2024', description: 'RECEBIMENTO CLIENTE ALFA', document: '4512', amount: '1.500,00', account: 'CC-A' },
  ]);
  await runReconciliation(app, admin, account.id, '2024-01-01', '2024-01-31');
  await importStatement(app, otherAdmin, otherAccount, [
    { date: '2024-01-07', amount: '777.77', memo: 'SEGREDO DA OUTRA EMPRESA' },
  ]);
});

afterAll(async () => {
  await app.close();
  await closePools();
});

/** Texto de um PDF gerado sem compressão: junta as cadeias hexadecimais dos operadores Tj/TJ, uma linha por operador. */
function pdfText(buffer: Buffer): string {
  const source = buffer.toString('latin1');
  const lines: string[] = [];
  for (const match of source.matchAll(/\[((?:<[0-9a-fA-F]*>|[-\d.\s])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
    const hex = [...(match[1] ?? match[2] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)].map((part) => part[1]).join('');
    lines.push(Buffer.from(hex, 'hex').toString('latin1'));
  }
  return lines.join('\n');
}

function csvRows(response: { raw: Buffer }): string[][] {
  const text = response.raw.toString('utf8');
  return parseCsv(text.replace(/^\u{FEFF}/u, ''), ';');
}

async function xlsxOf(response: { raw: Buffer }): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.raw as unknown as ArrayBuffer);
  return workbook;
}

async function auditExports(client: ApiClient): Promise<any[]> {
  const response = await client.get('/audit?action=export.created&limit=200');
  expect(response.status).toBe(200);
  return response.body.items;
}

describe('exportação de itens', () => {
  it('CSV: UTF-8 com BOM, ponto e vírgula, CRLF, só os itens do filtro e valores em formato brasileiro', async () => {
    const response = await admin.post('/exports/items', {
      format: 'csv',
      filters: { side: 'bank', bankAccountId: account.id, ...JAN },
    });
    expect(response.status, response.raw.toString()).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/csv');
    expect(String(response.headers['content-disposition'])).toContain('.csv');
    expect([...response.raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = response.raw.toString('utf8');
    expect(text).toContain('\r\n');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');

    const rows = csvRows(response);
    expect(rows[0]).toEqual(['Data', 'Descrição', 'Documento', 'Valor', 'Situação', 'Tipo', 'Conta']);
    const data = rows.slice(1);
    expect(data).toHaveLength(4);
    expect(data.map((row) => row[0]).sort()).toEqual(['05/01/2024', '10/01/2024', '12/01/2024', '15/01/2024']);
    expect(text).not.toContain('FEVEREIRO');
    expect(text).not.toContain('SEGREDO');
    expect(data.find((row) => row[1].includes('ALFA'))?.[3]).toBe('1500,00');
    expect(data.find((row) => row[1].includes('TARIFA'))?.[3]).toBe('-35,90');
    // Totais conferem com os valores conhecidos: 1500 - 320 + 980 - 35,90 = 2124,10.
    const sum = data.reduce((acc, row) => acc + Math.round(Number(row[3].replace(',', '.')) * 100), 0);
    expect(sum).toBe(212410);
  });

  it('CSV: neutraliza texto que começa com = + - @ tabulação ou CR, mas não os valores numéricos', async () => {
    for (const value of ['=1+1', '+55', '-x', '@SOMA', '\tabc', '\rabc']) {
      expect(neutralizeFormula(value)).toBe(`'${value}`);
    }
    expect(neutralizeFormula('normal')).toBe('normal');

    const response = await admin.post('/exports/items', { format: 'csv', filters: { side: 'bank', ...JAN } });
    const data = csvRows(response).slice(1);
    const injected = data.find((row) => row[1].includes('SOMA'));
    expect(injected?.[1].startsWith("'=")).toBe(true);
    expect(data.find((row) => row[1].includes('BOLETO'))?.[3]).toBe('-320,00');
  });

  it('CSV: filtros de situação, sentido e busca restringem as linhas', async () => {
    const credits = csvRows(await admin.post('/exports/items', { format: 'csv', filters: { side: 'bank', direction: 'credit', ...JAN } })).slice(1);
    expect(credits).toHaveLength(2);
    expect(credits.every((row) => !row[3].startsWith('-'))).toBe(true);

    const searched = csvRows(await admin.post('/exports/items', { format: 'csv', filters: { q: 'TARIFA' } })).slice(1);
    expect(searched).toHaveLength(1);

    const reconciled = csvRows(await admin.post('/exports/items', { format: 'csv', filters: { status: 'reconciled' } })).slice(1);
    expect(reconciled.length).toBeGreaterThan(0);
    expect(reconciled.every((row) => row[4] === 'Conciliado')).toBe(true);
  });

  it('XLSX: colunas tipadas, totais e texto neutralizado', async () => {
    const response = await admin.post('/exports/items', {
      format: 'xlsx',
      filters: { side: 'bank', bankAccountId: account.id, ...JAN },
    });
    expect(response.status).toBe(200);
    expect(String(response.headers['content-type'])).toContain('spreadsheetml');
    const sheet = (await xlsxOf(response)).getWorksheet('Itens');
    expect(sheet).toBeDefined();

    let headerRow = 0;
    sheet!.eachRow((row, number) => {
      if (row.getCell(1).value === 'Data') headerRow = number;
    });
    expect(headerRow).toBeGreaterThan(0);
    const header = sheet!.getRow(headerRow);
    const amountColumn = 4;
    expect(header.getCell(amountColumn).value).toBe('Valor');

    const dataRows = [1, 2, 3, 4].map((offset) => sheet!.getRow(headerRow + offset));
    for (const row of dataRows) {
      expect(row.getCell(1).value).toBeInstanceOf(Date);
      expect(typeof row.getCell(amountColumn).value).toBe('number');
    }
    const amounts = dataRows.map((row) => row.getCell(amountColumn).value as number);
    expect(amounts.sort((a, b) => a - b)).toEqual([-320, -35.9, 980, 1500]);
    const injected = dataRows.find((row) => String(row.getCell(2).value).includes('SOMA'));
    expect(String(injected?.getCell(2).value).startsWith("'=")).toBe(true);
    expect(JSON.stringify(injected?.getCell(2).value)).not.toContain('formula');

    // Totais ao final da planilha.
    const labels = new Map<string, unknown>();
    sheet!.eachRow((row) => {
      const label = row.getCell(1).value;
      if (typeof label === 'string' && /^(Total|Entradas|Saídas|Saldo)/.test(label)) labels.set(label, row.getCell(2).value);
    });
    expect(labels.get('Total de itens')).toBe(4);
    expect(labels.get('Entradas')).toBe(2480);
    expect(labels.get('Saídas')).toBe(-355.9);
    expect(labels.get('Saldo')).toBeCloseTo(2124.1, 2);
    expect(sheet!.getRow(headerRow + 5).getCell(1).value).not.toBe('05/02/2024');
  });

  it('PDF: cabeçalho %PDF, termina em %%EOF e o texto traz título, empresa, valores e totais', async () => {
    const response = await admin.post('/exports/items', {
      format: 'pdf',
      filters: { side: 'bank', bankAccountId: account.id, ...JAN },
    });
    expect(response.status).toBe(200);
    expect(String(response.headers['content-type'])).toContain('application/pdf');
    expect(response.raw.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(response.raw.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    // Em NODE_ENV=test o fluxo não é comprimido, o que permite extrair o texto com os operadores Tj/TJ.
    const text = pdfText(response.raw);
    expect(text).toContain('Itens de conciliação');
    expect(text).toContain('Empresa ');
    expect(text).toContain('R$ 1.500,00');
    expect(text).toContain('-R$ 35,90');
    expect(text).toContain('R$ 2.124,10');
    expect(text).toContain('Página 1 de 1');
    expect(text).not.toContain('FEVEREIRO');
    expect(text).not.toContain('SEGREDO');
    // Quatro itens.
    expect(text).toContain('PAGAMENTO BOLETO');
  });

  it('modelo de relatório define título e colunas; tipo errado e modelo inexistente são recusados', async () => {
    const created = await admin.post('/report-templates', {
      name: 'Itens enxutos',
      kind: 'items',
      config: { title: 'Meu relatório', columns: ['date', 'amount'] },
    });
    expect(created.status).toBe(201);
    const response = await admin.post('/exports/items', {
      format: 'csv',
      filters: { side: 'bank', ...JAN },
      templateId: created.body.id,
    });
    expect(response.status).toBe(200);
    expect(csvRows(response)[0]).toEqual(['Data', 'Valor']);

    const pdf = await admin.post('/exports/items', { format: 'pdf', filters: { side: 'bank', ...JAN }, templateId: created.body.id });
    expect(pdfText(pdf.raw)).toContain('Meu relatório');

    const summaryTemplate = (await admin.get('/report-templates')).body.items.find((t: any) => t.kind === 'summary');
    const wrongKind = await admin.post('/exports/items', { format: 'csv', filters: {}, templateId: summaryTemplate.id });
    expect(wrongKind.status).toBe(400);
    const missing = await admin.post('/exports/items', {
      format: 'csv',
      filters: {},
      templateId: '00000000-0000-4000-8000-000000000000',
    });
    expect(missing.status).toBe(404);
  });

  it('valida o corpo', async () => {
    expect((await admin.post('/exports/items', { format: 'docx', filters: {} })).status).toBe(400);
    expect((await admin.post('/exports/items', { filters: {} })).status).toBe(400);
    expect((await admin.post('/exports/items', { format: 'csv', filters: { dateFrom: 'ontem' } })).status).toBe(400);
  });

  it('acima do limite de linhas responde 422 e não gera arquivo', async () => {
    const original = exportLimits.maxRows;
    exportLimits.maxRows = 3;
    try {
      const response = await admin.post('/exports/items', { format: 'csv', filters: { side: 'bank', ...JAN } });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('export_too_large');
      // Exatamente no limite ainda passa.
      exportLimits.maxRows = 4;
      const ok = await admin.post('/exports/items', { format: 'csv', filters: { side: 'bank', ...JAN } });
      expect(ok.status).toBe(200);
    } finally {
      exportLimits.maxRows = original;
    }
  });
});

describe('resumo e lançamentos pendentes', () => {
  it('resumo em XLSX e PDF por situação, com pendentes, divergentes e regras', async () => {
    const body = { bankAccountId: account.id, ...JAN };
    const xlsx = await admin.post('/exports/summary', { format: 'xlsx', ...body });
    expect(xlsx.status, xlsx.raw.toString()).toBe(200);
    const workbook = await xlsxOf(xlsx);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(
      expect.arrayContaining(['Resumo', 'Pendentes', 'Divergentes', 'Regras']),
    );
    const summary = workbook.getWorksheet('Resumo')!;
    const rows = new Map<string, ExcelJS.Row>();
    summary.eachRow((row) => {
      if (typeof row.getCell(1).value === 'string') rows.set(row.getCell(1).value as string, row);
    });
    // Extrato: 4 itens de janeiro; um conciliado pela regra de identificador.
    expect(rows.get('Conciliado')?.getCell(2).value).toBe(1);
    expect(rows.get('Conciliado')?.getCell(3).value).toBe(1500);
    expect(rows.get('Total')?.getCell(2).value).toBe(4);

    const pdf = await admin.post('/exports/summary', { format: 'pdf', ...body });
    expect(pdf.status).toBe(200);
    expect(pdf.raw.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(pdf.raw.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    const text = pdfText(pdf.raw);
    expect(text).toContain('Relatório de conciliação bancária');
    expect(text).toContain('Conta A');
    expect(text).toContain('R$ 1.500,00');
  });

  it('resumo exige conta e período, só aceita pdf/xlsx e conta de outra empresa é 404', async () => {
    expect((await admin.post('/exports/summary', { format: 'csv', bankAccountId: account.id, ...JAN })).status).toBe(400);
    expect((await admin.post('/exports/summary', { format: 'pdf', ...JAN })).status).toBe(400);
    expect((await admin.post('/exports/summary', { format: 'pdf', bankAccountId: account.id })).status).toBe(400);
    const crossed = await otherAdmin.post('/exports/summary', { format: 'pdf', bankAccountId: account.id, ...JAN });
    expect(crossed.status).toBe(404);
  });

  it('classificações confirmadas sem lançamento saem em CSV e XLSX; as não classificadas ficam de fora', async () => {
    const empty = csvRows(await admin.post('/exports/pending-entries', { format: 'csv' })).slice(1);
    expect(empty).toHaveLength(0);

    const categories = await admin.get('/categories');
    const category = categories.body.items[0];
    const fee = bank.find((item) => item.description_raw?.includes('TARIFA') || item.description?.includes('TARIFA'));
    const classified = await admin.post('/reconciliation/items/classify', {
      bankTransactionId: fee.id,
      categoryId: category.id,
    });
    expect(classified.status, JSON.stringify(classified.body)).toBe(201);
    expect(classified.body.status).toBe('confirmed');

    const csv = await admin.post('/exports/pending-entries', { format: 'csv', bankAccountId: account.id, ...JAN });
    expect(csv.status).toBe(200);
    const rows = csvRows(csv);
    expect(rows[0]).toEqual(['Data', 'Descrição', 'Documento', 'Valor', 'Categoria', 'Conta']);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe('15/01/2024');
    expect(rows[1][3]).toBe('-35,90');
    expect(rows[1][4]).toBe(category.name);

    const xlsx = await admin.post('/exports/pending-entries', { format: 'xlsx' });
    expect(xlsx.status).toBe(200);
    const sheet = (await xlsxOf(xlsx)).worksheets[0]!;
    const found: unknown[] = [];
    sheet.eachRow((row) => {
      if (row.getCell(4).value === -35.9) found.push(row.getCell(5).value);
    });
    expect(found).toEqual([category.name]);

    expect((await admin.post('/exports/pending-entries', { format: 'pdf' })).status).toBe(400);
    // Outra empresa não enxerga a classificação.
    const none = csvRows(await otherAdmin.post('/exports/pending-entries', { format: 'csv' })).slice(1);
    expect(none).toHaveLength(0);
  });
});

describe('auditoria, permissão, isolamento e licença', () => {
  it('grava export.created com formato, filtros e quantidade', async () => {
    const before = (await auditExports(admin)).length;
    const response = await admin.post('/exports/items', {
      format: 'csv',
      filters: { side: 'bank', bankAccountId: account.id, ...JAN },
    });
    expect(response.status).toBe(200);
    const entries = await auditExports(admin);
    expect(entries.length).toBe(before + 1);
    const entry = entries[0];
    expect(entry.action).toBe('export.created');
    expect(entry.after).toMatchObject({
      report: 'items',
      format: 'csv',
      rows: 4,
      filters: { side: 'bank', bankAccountId: account.id, dateFrom: '2024-01-01', dateTo: '2024-01-31' },
    });

    const summary = await admin.post('/exports/summary', { format: 'pdf', bankAccountId: account.id, ...JAN });
    expect(summary.status).toBe(200);
    expect((await auditExports(admin))[0].after).toMatchObject({ report: 'summary', format: 'pdf' });
    await admin.post('/exports/pending-entries', { format: 'csv' });
    expect((await auditExports(admin))[0].after).toMatchObject({ report: 'pending-entries', format: 'csv' });
  });

  it('exige a permissão exports.create e a sessão', async () => {
    const role = await admin.post('/roles', { key: 'sem-exportacao', name: 'Sem exportação', permissions: ['dashboard.view'] });
    expect(role.status).toBe(201);
    const limited = await userWithRole(app, admin, 'sem-exportacao');
    for (const [url, body] of [
      ['/exports/items', { format: 'csv', filters: {} }],
      ['/exports/summary', { format: 'pdf', bankAccountId: account.id, ...JAN }],
      ['/exports/pending-entries', { format: 'csv' }],
    ] as const) {
      expect((await limited.post(url, body)).status).toBe(403);
    }
    const anonymous = new ApiClient(app);
    expect((await anonymous.post('/exports/items', { format: 'csv', filters: {} })).status).toBe(401);
    const analyst = await userWithRole(app, admin, 'analista');
    expect((await analyst.post('/exports/items', { format: 'csv', filters: { ...JAN } })).status).toBe(200);
  });

  it('uma empresa nunca exporta dados da outra', async () => {
    const theirs = await otherAdmin.post('/exports/items', {
      format: 'csv',
      filters: { bankAccountId: account.id },
    });
    expect(theirs.status).toBe(200);
    expect(csvRows(theirs)).toHaveLength(1); // só o cabeçalho
    const all = (await otherAdmin.post('/exports/items', { format: 'csv', filters: {} })).raw.toString('utf8');
    expect(all).toContain('SEGREDO DA OUTRA EMPRESA');
    expect(all).not.toContain('ALFA');

    const templates = await admin.get('/report-templates');
    const templateId = templates.body.items[0].id;
    expect((await otherAdmin.post('/exports/items', { format: 'csv', filters: {}, templateId })).status).toBe(404);
  });

  it('licença somente leitura não bloqueia a exportação', async () => {
    const suspended = await createTenant({ label: 'exporta-suspensa' });
    const client = await loggedIn(app, suspended.adminEmail);
    await ownerPool().query(`UPDATE tenant_licenses SET status = 'suspended' WHERE tenant_id = $1`, [suspended.tenantId]);
    expect((await client.get('/license')).body.readOnly).toBe(true);
    // Escrita comum é bloqueada…
    expect((await client.post('/categories', { code: 'X1', name: 'Bloqueada', kind: 'other' })).status).toBe(403);
    // …mas a exportação continua disponível.
    expect((await client.post('/exports/items', { format: 'csv', filters: {} })).status).toBe(200);
    expect((await client.post('/exports/pending-entries', { format: 'xlsx' })).status).toBe(200);
  });
});
