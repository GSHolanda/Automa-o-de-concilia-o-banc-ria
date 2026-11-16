import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { Cell } from './tabular';
import { inflateEntry, listZipEntries, SpreadsheetLimitError, storedZip, type ZipLimits } from './zip';

export interface XlsxReadResult {
  sheetNames: string[];
  sheet: string;
  rows: Cell[][];
}

export const MAX_SPREADSHEET_ROWS = 200_000;

/** Limites da leitura de XLSX: do zip (antes e durante a descompactação) e da aba lida. */
export interface XlsxLimits extends ZipLimits {
  maxRows: number;
  maxColumns: number;
  maxCells: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_XLSX_LIMITS: XlsxLimits = {
  maxEntries: 2_000,
  maxEntryBytes: 64 * MiB,
  maxTotalBytes: 128 * MiB,
  maxCompressionRatio: 200,
  maxRows: MAX_SPREADSHEET_ROWS,
  maxColumns: 512,
  maxCells: 4_000_000,
};

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

const INVALID = 'O arquivo não é uma planilha XLSX válida';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'amp') return '&';
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Atributos de uma marca XML, pelo nome local (sem prefixo). */
function attributesOf(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1] ?? '';
    const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    if (!result.has(local) || name.includes(':')) result.set(local, decodeXml(match[2] ?? match[3] ?? ''));
  }
  return result;
}

/** Caminho de uma parte apontada pelas relações do livro (relativas a `xl/`). */
function resolvePart(target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : `xl/${target}`).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part && part !== '.') resolved.push(part);
  }
  return resolved.join('/');
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index;
}

function rowsLimit(limits: XlsxLimits): SpreadsheetLimitError {
  return new SpreadsheetLimitError(`A planilha excede o limite de ${limits.maxRows} linhas`);
}

function columnsLimit(limits: XlsxLimits): SpreadsheetLimitError {
  return new SpreadsheetLimitError(`A planilha excede o limite de ${limits.maxColumns} colunas`);
}

function cellsLimit(limits: XlsxLimits): SpreadsheetLimitError {
  return new SpreadsheetLimitError(`A planilha excede o limite de ${limits.maxCells} células`);
}

/** Confere linhas, colunas e células da aba no XML, antes de montar qualquer linha. */
function scanSheet(xml: Buffer, limits: XlsxLimits): void {
  const text = xml.toString('latin1');
  let rows = 0;
  for (const match of text.matchAll(/<row\b([^>]*)>/g)) {
    rows += 1;
    const number = /\br\s*=\s*["'](\d+)["']/.exec(match[1] ?? '');
    if (rows > limits.maxRows || (number && Number(number[1]) > limits.maxRows)) throw rowsLimit(limits);
  }
  let cells = 0;
  for (const match of text.matchAll(/<c\b([^>]*)>/g)) {
    cells += 1;
    if (cells > limits.maxCells) throw cellsLimit(limits);
    const reference = /\br\s*=\s*["']([A-Za-z]+)(\d+)["']/.exec(match[1] ?? '');
    if (!reference) continue;
    if (columnIndex(reference[1] ?? '') > limits.maxColumns) throw columnsLimit(limits);
    if (Number(reference[2]) > limits.maxRows) throw rowsLimit(limits);
  }
}

const EMPTY_SHARED_STRINGS = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
);
const EMPTY_RELATIONSHIPS = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELATIONSHIPS}"/>`);

/**
 * Lê uma planilha XLSX em matriz de células. Sem `sheetName`, usa a primeira planilha.
 *
 * O arquivo nunca é descompactado por inteiro: o diretório central é conferido contra os limites, só as
 * partes necessárias (livro, relações, textos, estilos e a aba escolhida) são descompactadas, com a saída
 * limitada ao tamanho declarado, e a aba é lida em fluxo, interrompida ao passar dos limites de linhas e
 * colunas. Imagens e demais partes não são lidas.
 */
export async function readXlsx(
  bytes: Uint8Array,
  options: { sheetName?: string | null; limits?: Partial<XlsxLimits> },
): Promise<XlsxReadResult> {
  const limits: XlsxLimits = { ...DEFAULT_XLSX_LIMITS, ...options.limits };
  const entries = listZipEntries(bytes, limits);
  const read = async (path: string | null | undefined): Promise<Buffer | null> => {
    const entry = path ? entries.get(path) : undefined;
    return entry ? inflateEntry(bytes, entry) : null;
  };

  const workbookXml = await read('xl/workbook.xml');
  if (!workbookXml) throw new Error(INVALID);
  const relsXml = await read('xl/_rels/workbook.xml.rels');

  const relationships = new Map<string, { type: string; target: string }>();
  for (const match of (relsXml ?? EMPTY_RELATIONSHIPS).toString('utf8').matchAll(/<(?:\w+:)?Relationship\b([^>]*)>/g)) {
    const attributes = attributesOf(match[1] ?? '');
    const id = attributes.get('Id');
    if (id) relationships.set(id, { type: attributes.get('Type') ?? '', target: attributes.get('Target') ?? '' });
  }
  const partOfType = (suffix: string) => {
    for (const relation of relationships.values()) if (relation.type.endsWith(suffix)) return resolvePart(relation.target);
    return null;
  };

  const sheets: Array<{ name: string; rid: string }> = [];
  for (const match of workbookXml.toString('utf8').matchAll(/<(?:\w+:)?sheet\b([^>]*)>/g)) {
    const attributes = attributesOf(match[1] ?? '');
    sheets.push({ name: attributes.get('name') ?? '', rid: attributes.get('id') ?? '' });
  }
  const sheetNames = sheets.map((sheet) => sheet.name);
  if (sheets.length === 0) throw new Error('A planilha não contém abas');
  const chosen = options.sheetName ? sheets.find((sheet) => sheet.name === options.sheetName) : sheets[0];
  if (!chosen) throw new Error(`Aba "${options.sheetName}" não encontrada na planilha`);

  const relation = relationships.get(chosen.rid);
  const sheetXml = await read(relation ? resolvePart(relation.target) : null);
  if (!sheetXml) throw new Error(`Aba "${chosen.name}" não encontrada na planilha`);
  scanSheet(sheetXml, limits);
  const sharedStrings = (await read(partOfType('/sharedStrings'))) ?? EMPTY_SHARED_STRINGS;
  const styles = await read(partOfType('/styles'));

  // Zip reorganizado só com as partes conferidas: relações, livro, textos e estilos antes da aba, para que
  // o leitor em fluxo não precise guardar a aba em arquivo temporário.
  const files = [
    { name: 'xl/_rels/workbook.xml.rels', data: relsXml ?? EMPTY_RELATIONSHIPS },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/sharedStrings.xml', data: sharedStrings },
    ...(styles ? [{ name: 'xl/styles.xml', data: styles }] : []),
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ];
  const source = Readable.from(storedZip(files), { objectMode: false });
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
    entries: 'ignore',
  });

  const rows: Cell[][] = [];
  let cells = 0;
  try {
    for await (const worksheet of reader) {
      for await (const row of worksheet) {
        if (row.number > limits.maxRows) throw rowsLimit(limits);
        if (row.cellCount > limits.maxColumns) throw columnsLimit(limits);
        cells += row.cellCount;
        if (cells > limits.maxCells) throw cellsLimit(limits);
        while (rows.length < row.number - 1) rows.push([]);
        const values: Cell[] = [];
        for (let column = 1; column <= row.cellCount; column += 1) values.push(cellValue(row.getCell(column).value));
        rows.push(values);
      }
      break;
    }
  } catch (error) {
    if (error instanceof SpreadsheetLimitError) throw error;
    throw new Error(INVALID, { cause: error });
  } finally {
    source.destroy();
  }
  return { sheetNames, sheet: chosen.name, rows };
}
