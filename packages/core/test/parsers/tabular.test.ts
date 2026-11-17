import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { decodeText, detectDelimiter, parseCsv } from '../../src/parsers/csv';
import { mapTabular, suggestMapping } from '../../src/parsers/tabular';
import { readXlsx } from '../../src/parsers/xlsx';
import { importProfileConfigSchema } from '../../src/import-profile';

const profile = (config: unknown) => importProfileConfigSchema.parse(config);

describe('CSV', () => {
  it('detecta ponto e vírgula, vírgula e tabulação', () => {
    expect(detectDelimiter('Data;Histórico;Valor\n01/01/2024;X;1,00')).toBe(';');
    expect(detectDelimiter('date,description,amount\n2024-01-01,X,1.00')).toBe(',');
    expect(detectDelimiter('Data\tHistorico\tValor\n01/01/2024\tX\t1,00')).toBe('\t');
  });

  it('não confunde vírgula decimal com delimitador', () => {
    expect(detectDelimiter('Data;Valor\n01/01/2024;1.234,56\n02/01/2024;7,10')).toBe(';');
  });

  it('respeita aspas com delimitador e quebra de linha internos', () => {
    expect(parseCsv('a;b\n"x;1";"linha 1\nlinha 2"\n', ';')).toEqual([
      ['a', 'b'],
      ['x;1', 'linha 1\nlinha 2'],
    ]);
  });

  it('decodifica Windows-1252 quando os bytes não são UTF-8 válido e remove BOM', () => {
    expect(decodeText(Buffer.from('Histórico', 'latin1'), 'auto')).toEqual({
      text: 'Histórico',
      encoding: 'windows-1252',
    });
    expect(decodeText(Buffer.from('\ufeffHistórico', 'utf8'), 'auto')).toEqual({
      text: 'Histórico',
      encoding: 'utf-8',
    });
  });
});

describe('mapTabular', () => {
  it('mapeia extrato com valor assinado, pulando linhas de saldo', () => {
    const rows = parseCsv(
      [
        'Data;Histórico;Documento;Valor;Saldo',
        '02/01/2024;SALDO ANTERIOR;;;10.000,00',
        '05/01/2024;Pix recebido Padaria Bom Pão;4512;1.500,00;11.500,00',
        '08/01/2024;Tarifa pacote;;-35,90;11.464,10',
        ';;;;',
      ].join('\n'),
      ';',
    );
    const result = mapTabular(
      rows,
      profile({ columns: { date: 'Data', description: ['Histórico'], amount: 'Valor', document: 'Documento' } }),
    );

    expect(result.rejections).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.records).toEqual([
      expect.objectContaining({
        rowNumber: 3,
        date: '2024-01-05',
        amountCents: 150000,
        description: 'Pix recebido Padaria Bom Pão',
        document: '4512',
      }),
      expect.objectContaining({ rowNumber: 4, date: '2024-01-08', amountCents: -3590, document: null }),
    ]);
  });

  it('mapeia colunas separadas de débito e crédito', () => {
    const rows = parseCsv('Data;Descrição;Débito;Crédito\n05/01/2024;Venda;;200,00\n06/01/2024;Aluguel;1.000,00;', ';');
    const result = mapTabular(
      rows,
      profile({
        amountMode: 'debit_credit',
        columns: { date: 'Data', description: ['Descrição'], debit: 'Débito', credit: 'Crédito' },
      }),
    );
    expect(result.records.map((record) => record.amountCents)).toEqual([20000, -100000]);
  });

  it('mapeia coluna indicadora de tipo com valor absoluto', () => {
    const rows = parseCsv('Data;Descrição;Valor;Tipo\n05/01/2024;Venda;200,00;C\n06/01/2024;Aluguel;1.000,00;D', ';');
    const result = mapTabular(
      rows,
      profile({
        amountMode: 'type_column',
        columns: { date: 'Data', description: ['Descrição'], amount: 'Valor', typeColumn: 'Tipo' },
      }),
    );
    expect(result.records.map((record) => record.amountCents)).toEqual([20000, -100000]);
  });

  it('inverte o sinal quando o perfil pede', () => {
    const rows = parseCsv('Data;Descrição;Valor\n05/01/2024;Conta de luz;300,00', ';');
    const result = mapTabular(
      rows,
      profile({ invertSign: true, columns: { date: 'Data', description: ['Descrição'], amount: 'Valor' } }),
    );
    expect(result.records[0]?.amountCents).toBe(-30000);
  });

  it('rejeita linha com data ou valor inválido, com motivo, e mantém as demais', () => {
    const rows = parseCsv(
      'Data;Descrição;Valor\n31/02/2024;Data ruim;10,00\n05/01/2024;Valor ruim;dez\n06/01/2024;Boa;10,00',
      ';',
    );
    const result = mapTabular(
      rows,
      profile({ columns: { date: 'Data', description: ['Descrição'], amount: 'Valor' } }),
    );
    expect(result.records).toHaveLength(1);
    expect(result.rejections).toEqual([
      expect.objectContaining({ rowNumber: 2, reason: expect.stringMatching(/data/i) }),
      expect.objectContaining({ rowNumber: 3, reason: expect.stringMatching(/valor/i) }),
    ]);
    expect(result.rejections[0]?.raw).toMatchObject({ Descrição: 'Data ruim' });
  });

  it('resolve separador decimal pela coluna inteira quando um valor isolado seria ambíguo', () => {
    const rows = parseCsv('Data;Descrição;Valor\n05/01/2024;A;1.234\n06/01/2024;B;10,50', ';');
    const result = mapTabular(
      rows,
      profile({ columns: { date: 'Data', description: ['Descrição'], amount: 'Valor' } }),
    );
    expect(result.records.map((record) => record.amountCents)).toEqual([123400, 1050]);
  });

  it('aceita referência de coluna por posição e arquivo sem cabeçalho', () => {
    const rows = parseCsv('05/01/2024;Venda;200,00', ';');
    const result = mapTabular(
      rows,
      profile({ headerRow: 0, columns: { date: '#1', description: ['#2'], amount: '#3' } }),
    );
    expect(result.records[0]).toMatchObject({ rowNumber: 1, date: '2024-01-05', amountCents: 20000 });
  });

  it('concatena várias colunas de descrição', () => {
    const rows = parseCsv('Data;Histórico;Complemento;Valor\n05/01/2024;PIX;Fulano;1,00', ';');
    const result = mapTabular(
      rows,
      profile({ columns: { date: 'Data', description: ['Histórico', 'Complemento'], amount: 'Valor' } }),
    );
    expect(result.records[0]?.description).toBe('PIX Fulano');
  });

  it('falha de forma explícita quando uma coluna do perfil não existe no arquivo', () => {
    const rows = parseCsv('Data;Descrição;Valor\n05/01/2024;A;1,00', ';');
    expect(() =>
      mapTabular(rows, profile({ columns: { date: 'Dia', description: ['Descrição'], amount: 'Valor' } })),
    ).toThrow(/Dia/);
  });
});

describe('suggestMapping', () => {
  it('sugere colunas a partir de cabeçalhos usuais de extrato', () => {
    const rows = parseCsv(
      'Banco Fictício\n\nData Lançamento;Histórico;Nº Documento;Valor (R$);Saldo\n05/01/2024;X;1;1,00;1,00',
      ';',
    );
    const suggestion = suggestMapping(rows, 'bank');
    expect(suggestion.headerRow).toBe(3);
    expect(suggestion.amountMode).toBe('signed');
    expect(suggestion.columns).toMatchObject({
      date: 'Data Lançamento',
      description: ['Histórico'],
      document: 'Nº Documento',
      amount: 'Valor (R$)',
    });
  });

  it('sugere modo débito/crédito quando há as duas colunas', () => {
    const rows = parseCsv('Data;Descrição;Débito;Crédito\n05/01/2024;X;;1,00', ';');
    const suggestion = suggestMapping(rows, 'bank');
    expect(suggestion.amountMode).toBe('debit_credit');
    expect(suggestion.columns).toMatchObject({ debit: 'Débito', credit: 'Crédito' });
  });

  it('sugere identificador, fornecedor e vencimento em lançamentos', () => {
    const rows = parseCsv('ID;Data Pagamento;Vencimento;Fornecedor;Descrição;Documento;Valor\n1;05/01/2024;05/01/2024;X;Y;9;1,00', ';');
    const suggestion = suggestMapping(rows, 'ledger');
    expect(suggestion.columns).toMatchObject({
      externalId: 'ID',
      date: 'Data Pagamento',
      dueDate: 'Vencimento',
      counterparty: 'Fornecedor',
      document: 'Documento',
    });
  });
});

describe('XLSX', () => {
  async function workbook(): Promise<Uint8Array> {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Lançamentos');
    sheet.addRow(['Data', 'Descrição', 'Valor', 'Documento']);
    sheet.addRow([new Date(Date.UTC(2024, 0, 5)), 'Venda à vista', 1500.5, 4512]);
    sheet.addRow([new Date(Date.UTC(2024, 0, 8)), 'Aluguel', -1000, null]);
    sheet.addRow(['09/01/2024', 'Texto', '10,00', 'A-1']);
    sheet.getCell('C5').value = { formula: '1+1', result: 2 } as ExcelJS.CellValue;
    sheet.getCell('A5').value = new Date(Date.UTC(2024, 0, 10));
    sheet.getCell('B5').value = { richText: [{ text: 'Rico ' }, { text: 'texto' }] } as ExcelJS.CellValue;
    book.addWorksheet('Outra').addRow(['x']);
    return new Uint8Array(await book.xlsx.writeBuffer());
  }

  it('lê datas nativas, números, fórmulas pelo resultado e texto rico', async () => {
    const result = await readXlsx(await workbook(), {});
    expect(result.sheetNames).toEqual(['Lançamentos', 'Outra']);
    expect(result.sheet).toBe('Lançamentos');
    const mapped = mapTabular(
      result.rows,
      profile({ columns: { date: 'Data', description: ['Descrição'], amount: 'Valor', document: 'Documento' } }),
    );
    expect(mapped.rejections).toEqual([]);
    expect(mapped.records).toEqual([
      expect.objectContaining({ date: '2024-01-05', amountCents: 150050, document: '4512' }),
      expect.objectContaining({ date: '2024-01-08', amountCents: -100000 }),
      expect.objectContaining({ date: '2024-01-09', amountCents: 1000, document: 'A-1' }),
      expect.objectContaining({ date: '2024-01-10', amountCents: 200, description: 'Rico texto' }),
    ]);
  });

  it('lê a planilha indicada pelo nome e recusa nome inexistente', async () => {
    const bytes = await workbook();
    expect((await readXlsx(bytes, { sheetName: 'Outra' })).rows).toEqual([['x']]);
    await expect(readXlsx(bytes, { sheetName: 'Nada' })).rejects.toThrow(/Nada/);
  });

  it('recusa arquivo que não é XLSX', async () => {
    await expect(readXlsx(new Uint8Array([1, 2, 3]), {})).rejects.toThrow();
  });
});
