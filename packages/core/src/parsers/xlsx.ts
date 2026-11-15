import ExcelJS from 'exceljs';
import type { Cell } from './tabular';

export interface XlsxReadResult {
  sheetNames: string[];
  sheet: string;
  rows: Cell[][];
}

export const MAX_SPREADSHEET_ROWS = 200_000;

function cellValue(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'VERDADEIRO' : 'FALSO';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    // Fórmulas não são avaliadas: usa-se apenas o resultado gravado no arquivo.
    if ('result' in value) return cellValue(value.result as ExcelJS.CellValue);
    if ('formula' in value || 'sharedFormula' in value) return null;
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return String(value.text);
    if ('error' in value) return null;
  }
  return String(value);
}

/** Lê uma planilha XLSX em matriz de células. Sem `sheetName`, usa a primeira planilha. */
export async function readXlsx(
  bytes: Uint8Array,
  options: { sheetName?: string | null },
): Promise<XlsxReadResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs declara o tipo Buffer antigo; os bytes são aceitos como estão.
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (error) {
    throw new Error('O arquivo não é uma planilha XLSX válida', { cause: error });
  }
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  if (sheetNames.length === 0) throw new Error('A planilha não contém abas');

  const worksheet = options.sheetName
    ? workbook.worksheets.find((sheet) => sheet.name === options.sheetName)
    : workbook.worksheets[0];
  if (!worksheet) throw new Error(`Aba "${options.sheetName}" não encontrada na planilha`);
  if (worksheet.rowCount > MAX_SPREADSHEET_ROWS) {
    throw new Error(`A planilha excede o limite de ${MAX_SPREADSHEET_ROWS} linhas`);
  }

  const rows: Cell[][] = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: Cell[] = [];
    for (let column = 1; column <= row.cellCount; column += 1) {
      cells.push(cellValue(row.getCell(column).value));
    }
    rows.push(cells);
  });
  return { sheetNames, sheet: worksheet.name, rows };
}
