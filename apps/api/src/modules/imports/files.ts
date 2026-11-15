import { extname } from 'node:path';
import {
  decodeOfxBuffer,
  decodeText,
  detectDelimiter,
  normalizeDescription,
  parseCsv,
  parseOfx,
  readXlsx,
  suggestMapping,
  type Cell,
  type Delimiter,
  type ImportProfileConfig,
  type OfxStatement,
  type OfxTransaction,
  type TextEncoding,
} from '@concilia/core';
import { badRequest } from '../../http/errors';

export type FileFormat = 'ofx' | 'csv' | 'xlsx';
export type SourceKind = 'bank' | 'ledger';

export const CONTENT_TYPES: Record<FileFormat, string> = {
  ofx: 'application/x-ofx',
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Erro no conteúdo do arquivo ou no mapeamento: o lote falha sem repetir o trabalho. */
export class ImportContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportContentError';
  }
}

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);
const SNIFF_BYTES = 64 * 1024;

/** Formato pelo conteúdo (OFX contém `<OFX>`; XLSX começa com `PK`), conferido com a extensão. */
export function detectFileFormat(fileName: string, content: Buffer): FileFormat {
  const extension = extname(fileName).toLowerCase();
  if (content.length >= 2 && content[0] === 0x50 && content[1] === 0x4b) return 'xlsx';
  if (content.subarray(0, 4).equals(OLE_SIGNATURE)) {
    throw badRequest('Planilhas no formato antigo (.xls) não são aceitas. Salve o arquivo como .xlsx.', 'unsupported_format');
  }
  const head = content.subarray(0, SNIFF_BYTES);
  if (/<OFX>/i.test(head.toString('latin1'))) return 'ofx';
  if (extension === '.ofx' || extension === '.qfx') {
    throw badRequest('O arquivo não parece ser um OFX válido: a marcação <OFX> não foi encontrada.', 'invalid_file');
  }
  if (extension === '.xlsx') throw badRequest('O arquivo não é uma planilha XLSX válida.', 'invalid_file');
  if (head.includes(0)) {
    throw badRequest('Formato de arquivo não reconhecido. Envie OFX, CSV ou XLSX.', 'unsupported_format');
  }
  return 'csv';
}

// ---------------------------------------------------------------------------
// OFX
// ---------------------------------------------------------------------------

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * Compara a conta do OFX (ACCTID) com o número cadastrado, só pelos dígitos: uma termina com a outra
 * (bancos costumam prefixar agência ou zeros). Nulo quando não há como comparar.
 */
export function ofxAccountMatches(accountId: string | null, accountNumber: string | null): boolean | null {
  const fromFile = digits(accountId).replace(/^0+/, '');
  const registered = digits(accountNumber).replace(/^0+/, '');
  if (fromFile === '' || registered === '') return null;
  return fromFile.endsWith(registered) || registered.endsWith(fromFile);
}

export function readOfx(content: Buffer): OfxStatement[] {
  const statements = parseOfx(decodeOfxBuffer(content));
  if (statements.length === 0) throw new ImportContentError('O arquivo OFX não contém extrato bancário.');
  return statements;
}

/** Extrato da conta selecionada; sem correspondência, o primeiro do arquivo. */
export function pickStatement(
  statements: OfxStatement[],
  accountNumber: string | null,
): { statement: OfxStatement; matches: boolean | null } {
  for (const statement of statements) {
    if (ofxAccountMatches(statement.accountId, accountNumber) === true) return { statement, matches: true };
  }
  const first = statements[0] as OfxStatement;
  return { statement: first, matches: ofxAccountMatches(first.accountId, accountNumber) };
}

/** Descrição de uma transação OFX: MEMO, precedido de NAME quando este traz informação a mais. */
export function ofxDescription(transaction: OfxTransaction): string {
  const memo = transaction.raw.MEMO ?? '';
  const name = transaction.raw.NAME ?? '';
  if (memo && name && !normalizeDescription(memo).includes(normalizeDescription(name))) return `${name} ${memo}`;
  return memo || name || transaction.type || '';
}

// ---------------------------------------------------------------------------
// CSV e XLSX
// ---------------------------------------------------------------------------

export interface TabularOptions {
  encoding: 'auto' | TextEncoding;
  delimiter: 'auto' | Delimiter | 'tab';
  sheetName: string | null;
}

export interface TabularRows {
  rows: Cell[][];
  sheetNames?: string[];
  sheetName?: string;
  encoding?: TextEncoding;
  delimiter?: Delimiter;
}

const DEFAULT_TABULAR: TabularOptions = { encoding: 'auto', delimiter: 'auto', sheetName: null };

export function tabularOptions(config: ImportProfileConfig | null): TabularOptions {
  if (!config) return DEFAULT_TABULAR;
  return { encoding: config.encoding, delimiter: config.delimiter, sheetName: config.sheetName };
}

/** Lê CSV ou XLSX em matriz de células. Arquivo ilegível vira ImportContentError. */
export async function readTabular(format: 'csv' | 'xlsx', content: Buffer, options: TabularOptions): Promise<TabularRows> {
  try {
    if (format === 'xlsx') {
      const sheet = await readXlsx(content, { sheetName: options.sheetName });
      return { rows: sheet.rows, sheetNames: sheet.sheetNames, sheetName: sheet.sheet };
    }
    const decoded = decodeText(content, options.encoding);
    const delimiter =
      options.delimiter === 'auto'
        ? detectDelimiter(decoded.text)
        : options.delimiter === 'tab'
          ? '\t'
          : options.delimiter;
    return { rows: parseCsv(decoded.text, delimiter), encoding: decoded.encoding, delimiter };
  } catch (error) {
    throw new ImportContentError(error instanceof Error ? error.message : 'Não foi possível ler o arquivo.');
  }
}

// ---------------------------------------------------------------------------
// Pré-visualização
// ---------------------------------------------------------------------------

const SAMPLE_SIZE = 10;

function displayCell(cell: Cell | undefined): string | number | null {
  if (cell === null || cell === undefined) return null;
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell.toISOString().slice(0, 10);
  return cell;
}

function headersAt(rows: Cell[][], headerRow: number): string[] {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const header = headerRow > 0 ? (rows[headerRow - 1] ?? []) : [];
  return Array.from({ length: Math.max(width, header.length) }, (_, index) => {
    const value = displayCell(header[index]);
    const text = value === null ? '' : String(value).trim();
    return text || `#${index + 1}`;
  });
}

export interface PreviewInput {
  format: FileFormat;
  sourceKind: SourceKind;
  content: Buffer;
  accountNumber: string | null;
  profileConfig: ImportProfileConfig | null;
  sheetName?: string | null;
}

/** Pré-visualização do arquivo. Arquivo ilegível responde 400. */
export async function buildPreview(input: PreviewInput): Promise<Record<string, unknown>> {
  try {
    if (input.format === 'ofx') {
      const statements = readOfx(input.content);
      const { statement, matches } = pickStatement(statements, input.accountNumber);
      return {
        account: {
          bankId: statement.bankId,
          branchId: statement.branchId,
          accountId: statement.accountId,
          accountType: statement.accountType,
          currency: statement.currency,
        },
        statementCount: statements.length,
        period: { start: statement.startDate, end: statement.endDate },
        transactionCount: statement.transactions.length,
        invalidCount: statement.errors.length,
        sample: statement.transactions.slice(0, SAMPLE_SIZE).map((transaction) => ({
          date: transaction.postedDate,
          amountCents: transaction.amountCents,
          description: ofxDescription(transaction),
          type: transaction.type,
          fitId: transaction.fitId,
        })),
        accountMatches: matches,
      };
    }
    const options = tabularOptions(input.profileConfig);
    const table = await readTabular(input.format, input.content, {
      ...options,
      sheetName: input.sheetName ?? options.sheetName,
    });
    const suggestion = suggestMapping(table.rows, input.sourceKind);
    const headerRow = input.profileConfig?.headerRow ?? suggestion.headerRow;
    const headers = headerRow === suggestion.headerRow ? suggestion.headers : headersAt(table.rows, headerRow);
    return {
      ...(table.sheetNames ? { sheetNames: table.sheetNames, sheetName: table.sheetName } : {}),
      ...(table.encoding ? { encoding: table.encoding, delimiter: table.delimiter } : {}),
      headerRow,
      headers,
      rowCount: Math.max(table.rows.length - headerRow, 0),
      sampleRows: table.rows.slice(headerRow, headerRow + SAMPLE_SIZE).map((row) => row.map(displayCell)),
      suggestion,
    };
  } catch (error) {
    if (error instanceof ImportContentError) throw badRequest(error.message, 'invalid_file');
    throw error;
  }
}
