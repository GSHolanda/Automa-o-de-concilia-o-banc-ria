import { describe, expect, it, vi } from 'vitest';
import {
  decodeOfxBuffer,
  decodeText,
  importProfileConfigSchema,
  mapTabular,
  parseCsv,
  parseOfx,
  readXlsx,
  type OfxTransaction,
} from '@concilia/core';
import { buildDemoFiles } from '../../src/demo/files';

type DemoFiles = Awaited<ReturnType<typeof buildDemoFiles>>;

async function loadFiles(): Promise<DemoFiles> {
  return buildDemoFiles();
}

function byName(files: DemoFiles, name: string) {
  const file = files.find((item) => item.name === name);
  if (!file) throw new Error(`arquivo ausente: ${name}`);
  return file;
}

function readOfx(files: DemoFiles, name: string): OfxTransaction[] {
  const statements = parseOfx(decodeOfxBuffer(byName(files, name).content));
  expect(statements).toHaveLength(1);
  expect(statements[0]?.errors).toEqual([]);
  return statements[0]?.transactions ?? [];
}

function readCsvRecords(files: DemoFiles, name: string) {
  const { text } = decodeText(byName(files, name).content, 'auto');
  const config = importProfileConfigSchema.parse({
    delimiter: ';',
    encoding: 'utf-8',
    headerRow: 1,
    dateFormat: 'DD/MM/YYYY',
    decimalSeparator: ',',
    amountMode: 'signed',
    columns: { date: 'Data', description: ['Histórico'], amount: 'Valor', document: 'Documento' },
  });
  return mapTabular(parseCsv(text, ';'), config);
}

async function readLedger(files: DemoFiles) {
  const sheet = await readXlsx(byName(files, 'lancamentos-2024-01.xlsx').content, { sheetName: null });
  const config = importProfileConfigSchema.parse({
    headerRow: 1,
    dateFormat: 'auto',
    amountMode: 'signed',
    columns: {
      date: 'Data Pagamento',
      description: ['Descrição'],
      amount: 'Valor',
      document: 'Documento',
      counterparty: 'Favorecido',
      dueDate: 'Vencimento',
      externalId: 'ID',
      bankAccountRef: 'Conta',
    },
  });
  return mapTabular(sheet.rows, config);
}

describe('arquivos fictícios de demonstração', () => {
  it('lista os quatro arquivos com tipo e conta corretos', async () => {
    const files = await loadFiles();
    expect(files.map((file) => [file.name, file.kind, file.account])).toEqual([
      ['extrato-movimento-2024-01.ofx', 'bank', 'movimento'],
      ['extrato-movimento-2024-01-complemento.ofx', 'bank', 'movimento'],
      ['extrato-reserva-2024-01.csv', 'bank', 'reserva'],
      ['lancamentos-2024-01.xlsx', 'ledger', null],
    ]);
  });

  it('cada arquivo é lido sem erros nem rejeições', async () => {
    const files = await loadFiles();
    expect(readOfx(files, 'extrato-movimento-2024-01.ofx')).toHaveLength(37);
    expect(readOfx(files, 'extrato-movimento-2024-01-complemento.ofx')).toHaveLength(12);
    const reserva = readCsvRecords(files, 'extrato-reserva-2024-01.csv');
    expect(reserva.rejections).toEqual([]);
    const ledger = await readLedger(files);
    expect(ledger.rejections).toEqual([]);
  });

  it('extrato MOVIMENTO de janeiro bate com a lista de transações', async () => {
    const files = await loadFiles();
    const txs = readOfx(files, 'extrato-movimento-2024-01.ofx');
    const memos = txs.map((tx) => tx.memo);
    expect(memos.filter((memo) => /^PIX RECEBIDO .+ NF 45\d\d$/.test(memo))).toHaveLength(13);
    const fornecedores = txs.filter((tx) => /^PAGTO FORNECEDOR .+ DOC 8801\d\d$/.test(tx.memo));
    expect(fornecedores).toHaveLength(8);
    expect(fornecedores.every((tx) => tx.amountCents < 0)).toBe(true);
    expect(memos.filter((memo) => memo === 'PIX RECEBIDO CLIENTE AVULSO')).toHaveLength(2);
    expect(memos.filter((memo) => /^PIX RECEBIDO LOJA /.test(memo))).toHaveLength(5);
    expect(memos.filter((memo) => memo === 'DEP LOTE CARTOES')).toHaveLength(1);
    expect(memos.filter((memo) => /^TARIFA PACOTE|^TAR PIX$|^IOF$/.test(memo))).toHaveLength(3);
    expect(memos.filter((memo) => /BOLETO ENERGIA/.test(memo))).toHaveLength(2);
    expect(memos.filter((memo) => memo.startsWith('TRANSF ENTRE CONTAS'))).toHaveLength(1);
    expect(memos.filter((memo) => memo === 'PIX RECEBIDO NAO IDENTIFICADO')).toHaveLength(1);
    expect(memos.filter((memo) => memo === 'DEBITO AUTOMATICO SEGURO')).toHaveLength(1);
    const fitIds = new Set(txs.map((tx) => tx.fitId));
    expect(fitIds.size).toBe(txs.length);
  });

  it('complemento repete as transações de 25/01 em diante e acrescenta 3 novas', async () => {
    const files = await loadFiles();
    const principal = readOfx(files, 'extrato-movimento-2024-01.ofx');
    const complemento = readOfx(files, 'extrato-movimento-2024-01-complemento.ofx');
    const fitPrincipal = new Set(principal.map((tx) => tx.fitId));
    const repetidas = complemento.filter((tx) => fitPrincipal.has(tx.fitId));
    const novas = complemento.filter((tx) => !fitPrincipal.has(tx.fitId));
    expect(repetidas).toHaveLength(9);
    expect(novas).toHaveLength(3);
    for (const tx of repetidas) {
      const original = principal.find((item) => item.fitId === tx.fitId);
      expect(original).toMatchObject({ postedDate: tx.postedDate, amountCents: tx.amountCents, memo: tx.memo });
      expect(tx.postedDate >= '2024-01-25').toBe(true);
    }
    expect(new Set(complemento.map((tx) => tx.fitId)).size).toBe(complemento.length);
  });

  it('extrato RESERVA traz o crédito de R$ 10.000,00 e os demais movimentos', async () => {
    const files = await loadFiles();
    const result = readCsvRecords(files, 'extrato-reserva-2024-01.csv');
    expect(result.records).toHaveLength(5);
    expect(result.skipped).toBe(1);
    const transfer = result.records.find((record) => record.description.startsWith('TRANSF ENTRE CONTAS'));
    expect(transfer).toMatchObject({ date: '2024-01-20', amountCents: 1_000_000 });
  });

  it('lançamentos batem com as regras da demonstração', async () => {
    const files = await loadFiles();
    const ledger = await readLedger(files);
    expect(ledger.records).toHaveLength(34);
    const cartoes = ledger.records.filter((record) => record.counterparty === 'ADQUIRENTE CARTOES');
    expect(cartoes).toHaveLength(3);
    const somaCartoes = cartoes.reduce((total, record) => total + record.amountCents, 0);
    const deposito = readOfx(files, 'extrato-movimento-2024-01.ofx').find((tx) => tx.memo === 'DEP LOTE CARTOES');
    expect(somaCartoes).toBe(deposito?.amountCents);
    expect(somaCartoes).toBe(360_000);
  });

  it('chamar buildDemoFiles duas vezes devolve conteúdo idêntico, mesmo com outro relógio', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2024-03-01T10:00:00Z'));
      const first = await loadFiles();
      vi.setSystemTime(new Date('2026-11-16T18:45:33Z'));
      const second = await loadFiles();
      expect(second.map((file) => file.name)).toEqual(first.map((file) => file.name));
      for (const [index, file] of first.entries()) {
        expect(Buffer.compare(file.content, second[index]?.content ?? Buffer.alloc(0))).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('o conteúdo não depende do relógio em nenhuma geração', async () => {
    const first = await loadFiles();
    const second = await loadFiles();
    expect(second.map((file) => file.name)).toEqual(first.map((file) => file.name));
    for (const [index, file] of first.entries()) {
      expect(Buffer.compare(file.content, second[index]?.content ?? Buffer.alloc(0))).toBe(0);
    }
  });
});
