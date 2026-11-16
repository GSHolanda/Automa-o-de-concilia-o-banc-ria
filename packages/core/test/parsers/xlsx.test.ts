import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readXlsx } from '../../src/parsers/xlsx';
import { buildZip, deflatedZeros, numericRows, xlsxParts } from '../helpers/zip';

const MiB = 1024 * 1024;

describe('leitura de XLSX com limites', () => {
  it('lê a planilha mínima montada no teste', async () => {
    const result = await readXlsx(buildZip(xlsxParts(numericRows(3, 2))), {});
    expect(result.sheetNames).toEqual(['Plan1']);
    expect(result.rows).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('recusa sem descompactar entrada que declara tamanho enorme (imagem de 1 GiB)', async () => {
    const zeros = await deflatedZeros(4 * MiB);
    const bytes = buildZip([
      ...xlsxParts(numericRows(2)),
      { name: 'xl/media/image1.png', deflated: zeros, declaredSize: 1024 * MiB },
    ]);
    expect(bytes.length).toBeLessThan(MiB);
    await expect(readXlsx(bytes, {})).rejects.toThrow(/descompactad/i);
  });

  it('recusa bomba honesta de compressão: 300 MiB de zeros em menos de 1 MB', async () => {
    const zeros = await deflatedZeros(300 * MiB);
    const bytes = buildZip([...xlsxParts(numericRows(2)), { name: 'xl/media/image1.png', deflated: zeros }]);
    expect(bytes.length).toBeLessThan(MiB);
    const before = process.memoryUsage().rss;
    await expect(readXlsx(bytes, {})).rejects.toThrow(/descompactad|compress/i);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * MiB);
  });

  it('recusa entrada com razão de compressão fora do normal, mesmo dentro do tamanho total', async () => {
    const zeros = await deflatedZeros(8 * MiB);
    const bytes = buildZip([...xlsxParts(numericRows(2)), { name: 'xl/media/image1.png', deflated: zeros }]);
    await expect(readXlsx(bytes, {})).rejects.toThrow(/compress/i);
  });

  it('interrompe a leitura quando a aba descompacta mais do que declarou', async () => {
    const sheet = xlsxParts(numericRows(2))[4]!.data!;
    const big = Buffer.concat([sheet.subarray(0, sheet.length - 24), Buffer.alloc(5 * MiB, 0x20), sheet.subarray(-24)]);
    const bytes = buildZip(xlsxParts('', { data: big, declaredSize: sheet.length }));
    await expect(readXlsx(bytes, {})).rejects.toThrow(/não confere|descompactad/i);
  });

  it('recusa zip com entradas demais', async () => {
    const extra = Array.from({ length: 2100 }, (_, index) => ({ name: `xl/custom/item${index}.xml`, data: Buffer.from('x') }));
    await expect(readXlsx(buildZip([...xlsxParts(numericRows(1)), ...extra]), {})).rejects.toThrow(/entradas/i);
  });

  it('recusa aba com linhas além do limite', async () => {
    const bytes = buildZip(xlsxParts(numericRows(60)));
    await expect(readXlsx(bytes, { limits: { maxRows: 50 } })).rejects.toThrow(/50 linhas/);
    // Uma única célula numa linha distante também conta.
    const far = buildZip(xlsxParts('<row r="1000000"><c r="A1000000"><v>1</v></c></row>'));
    await expect(readXlsx(far, { limits: { maxRows: 50 } })).rejects.toThrow(/50 linhas/);
  });

  it('recusa aba com colunas além do limite', async () => {
    const bytes = buildZip(xlsxParts('<row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>2</v></c></row>'));
    await expect(readXlsx(bytes, {})).rejects.toThrow(/colunas/);
    // Muitas linhas com uma célula na última coluna: recusa antes de montar as linhas.
    let rows = '';
    for (let row = 1; row <= 3000; row += 1) rows += `<row r="${row}"><c r="XFD${row}"><v>1</v></c></row>`;
    const before = process.memoryUsage().rss;
    await expect(readXlsx(buildZip(xlsxParts(rows)), {})).rejects.toThrow(/colunas/);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * MiB);
  });

  it('ignora imagens e outras partes que a importação não usa', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Extrato').addRow(['Data', 'Valor']);
    const image = book.addImage({ buffer: Buffer.alloc(2048, 7) as unknown as ExcelJS.Buffer, extension: 'png' });
    book.getWorksheet('Extrato')!.addImage(image, 'C3:D4');
    const result = await readXlsx(new Uint8Array(await book.xlsx.writeBuffer()), {});
    expect(result.rows).toEqual([['Data', 'Valor']]);
  });
});
