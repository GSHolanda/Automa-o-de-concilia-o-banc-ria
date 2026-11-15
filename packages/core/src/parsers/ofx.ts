import { DateParseError, parseOfxDate } from '../dates';
import { AmountParseError, parseAmount } from '../money';

export interface OfxTransaction {
  fitId: string | null;
  type: string | null;
  postedDate: string;
  amountCents: number;
  checkNumber: string | null;
  refNumber: string | null;
  name: string | null;
  memo: string;
  raw: Record<string, string>;
}

export interface OfxTransactionError {
  /** Posição da transação dentro do extrato (base zero). */
  index: number;
  message: string;
  raw: Record<string, string>;
}

export interface OfxStatement {
  bankId: string | null;
  branchId: string | null;
  accountId: string | null;
  accountType: string | null;
  currency: string | null;
  startDate: string | null;
  endDate: string | null;
  ledgerBalanceCents: number | null;
  ledgerBalanceDate: string | null;
  transactions: OfxTransaction[];
  errors: OfxTransactionError[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ENTITIES[name] ?? '');
}

/** Campos folha de um bloco: <TAG>valor, com ou sem </TAG>. O primeiro valor de cada tag prevalece. */
function fields(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of block.matchAll(/<([A-Z0-9_.]+)>([^<\r\n]*)/gi)) {
    const tag = (match[1] ?? '').toUpperCase();
    const value = decodeEntities(match[2] ?? '').trim();
    if (value !== '' && !(tag in result)) result[tag] = value;
  }
  return result;
}

function section(content: string, tag: string): string | null {
  const open = new RegExp(`<${tag}>`, 'i').exec(content);
  if (!open) return null;
  const rest = content.slice(open.index + open[0].length);
  const close = new RegExp(`</${tag}>`, 'i').exec(rest);
  return close ? rest.slice(0, close.index) : rest;
}

function ofxAmount(value: string): number {
  // No OFX não há separador de milhar: um único separador é sempre decimal.
  const hasComma = value.includes(',');
  const hasDot = value.includes('.');
  const decimalSeparator = hasComma && !hasDot ? ',' : hasDot && !hasComma ? '.' : 'auto';
  return parseAmount(value, { decimalSeparator });
}

function optionalDate(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return parseOfxDate(value);
  } catch {
    return null;
  }
}

function parseTransaction(raw: Record<string, string>): OfxTransaction {
  if (!raw.DTPOSTED) throw new DateParseError('Transação sem data (DTPOSTED)', null);
  if (!raw.TRNAMT) throw new AmountParseError('Transação sem valor (TRNAMT)', null);
  const type = raw.TRNTYPE ? raw.TRNTYPE.toUpperCase() : null;
  let amountCents = ofxAmount(raw.TRNAMT);
  // Alguns bancos enviam débitos com valor positivo; o tipo DEBIT é inequívoco.
  if (type === 'DEBIT' && amountCents > 0) amountCents = -amountCents;
  return {
    fitId: raw.FITID ?? null,
    type,
    postedDate: parseOfxDate(raw.DTPOSTED),
    amountCents,
    checkNumber: raw.CHECKNUM ?? null,
    refNumber: raw.REFNUM ?? null,
    name: raw.NAME ?? null,
    memo: raw.MEMO ?? raw.NAME ?? '',
    raw,
  };
}

function parseStatement(chunk: string): OfxStatement {
  const account = fields(section(chunk, 'BANKACCTFROM') ?? section(chunk, 'CCACCTFROM') ?? '');
  const list = section(chunk, 'BANKTRANLIST') ?? '';
  const listHeader = fields(list.split(/<STMTTRN>/i)[0] ?? '');
  const balance = fields(section(chunk, 'LEDGERBAL') ?? '');
  const head = fields(chunk.split(/<BANKACCTFROM>|<CCACCTFROM>/i)[0] ?? '');

  const transactions: OfxTransaction[] = [];
  const errors: OfxTransactionError[] = [];
  const blocks = list.split(/<STMTTRN>/i).slice(1);
  blocks.forEach((block, index) => {
    const raw = fields(block.split(/<\/STMTTRN>/i)[0] ?? '');
    try {
      transactions.push(parseTransaction(raw));
    } catch (error) {
      const reason =
        error instanceof DateParseError
          ? `Data inválida: ${error.message}`
          : error instanceof AmountParseError
            ? `Valor inválido: ${error.message}`
            : 'Transação inválida';
      errors.push({ index, message: reason, raw });
    }
  });

  let ledgerBalanceCents: number | null = null;
  if (balance.BALAMT) {
    try {
      ledgerBalanceCents = ofxAmount(balance.BALAMT);
    } catch {
      ledgerBalanceCents = null;
    }
  }

  return {
    bankId: account.BANKID ?? null,
    branchId: account.BRANCHID ?? null,
    accountId: account.ACCTID ?? null,
    accountType: account.ACCTTYPE ?? null,
    currency: head.CURDEF ?? null,
    startDate: optionalDate(listHeader.DTSTART),
    endDate: optionalDate(listHeader.DTEND),
    ledgerBalanceCents,
    ledgerBalanceDate: optionalDate(balance.DTASOF),
    transactions,
    errors,
  };
}

/** Lê OFX 1.x (SGML) e 2.x (XML). Devolve um extrato por conta presente no arquivo. */
export function parseOfx(content: string): OfxStatement[] {
  const chunks = content.split(/<(?:CC)?STMTRS>/i).slice(1);
  return chunks.map((chunk) => parseStatement(chunk.split(/<\/(?:CC)?STMTRS>/i)[0] ?? chunk));
}

function declaredCharset(headerAscii: string): 'utf-8' | 'windows-1252' | null {
  if (/encoding\s*=\s*["']utf-?8["']/i.test(headerAscii)) return 'utf-8';
  if (/ENCODING\s*:\s*(UTF-?8|UNICODE)/i.test(headerAscii)) return 'utf-8';
  if (/CHARSET\s*:\s*(1252|ISO-?8859-?1)/i.test(headerAscii)) return 'windows-1252';
  if (/encoding\s*=\s*["'](ISO-?8859-?1|WINDOWS-?1252)["']/i.test(headerAscii)) return 'windows-1252';
  return null;
}

/** Decodifica os bytes de um OFX conforme o cabeçalho, com recuo seguro para Windows-1252. */
export function decodeOfxBuffer(bytes: Uint8Array): string {
  const header = new TextDecoder('windows-1252').decode(bytes.subarray(0, 512));
  const charset = declaredCharset(header);
  if (charset !== 'windows-1252') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, '');
    } catch {
      // segue para Windows-1252
    }
  }
  return new TextDecoder('windows-1252').decode(bytes);
}
