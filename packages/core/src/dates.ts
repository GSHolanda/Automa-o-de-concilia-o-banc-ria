/**
 * Datas civis no formato ISO "AAAA-MM-DD", sem fuso horário.
 */

export class DateParseError extends Error {
  constructor(
    message: string,
    readonly input: unknown,
  ) {
    super(message);
    this.name = 'DateParseError';
  }
}

export type DateFormat =
  | 'auto'
  | 'DD/MM/YYYY'
  | 'MM/DD/YYYY'
  | 'YYYY-MM-DD'
  | 'YYYYMMDD';

export interface ParseDateOptions {
  format?: DateFormat;
}

const MS_PER_DAY = 86_400_000;

function pad(value: number, size = 2): string {
  return value.toString().padStart(size, '0');
}

function build(year: number, month: number, day: number, input: unknown): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    year >= 1900 &&
    year <= 2200 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!valid) throw new DateParseError('Data inexistente', input);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function expandYear(year: number, digits: number): number {
  if (digits > 2) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}

/** Converte texto, Date ou número serial de planilha em data ISO. */
export function parseDate(input: string | number | Date, options: ParseDateOptions = {}): string {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new DateParseError('Data inválida', input);
    return build(input.getUTCFullYear(), input.getUTCMonth() + 1, input.getUTCDate(), input);
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 1 || input > 110_000) throw new DateParseError('Número de data inválido', input);
    // Sistema de datas 1900 das planilhas: dia 1 = 1900-01-01, com o dia 29/02/1900 fictício.
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(input) * MS_PER_DAY);
    return build(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), input);
  }

  const text = String(input ?? '').trim();
  if (text === '') throw new DateParseError('Data vazia', input);
  const format = options.format ?? 'auto';

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(text);
  if (iso && (format === 'auto' || format === 'YYYY-MM-DD')) {
    return build(Number(iso[1]), Number(iso[2]), Number(iso[3]), input);
  }

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact && (format === 'auto' || format === 'YYYYMMDD')) {
    return build(Number(compact[1]), Number(compact[2]), Number(compact[3]), input);
  }

  const parts = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/.exec(text);
  if (parts && (format === 'auto' || format === 'DD/MM/YYYY' || format === 'MM/DD/YYYY')) {
    const first = Number(parts[1]);
    const second = Number(parts[2]);
    const year = expandYear(Number(parts[3]), (parts[3] ?? '').length);
    return format === 'MM/DD/YYYY' ? build(year, first, second, input) : build(year, second, first, input);
  }

  throw new DateParseError('Formato de data não reconhecido', input);
}

/** Data OFX: AAAAMMDD[HHMMSS[.XXX]][[fuso]]. A data civil informada pelo banco é mantida. */
export function parseOfxDate(input: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(String(input ?? '').trim());
  if (!match) throw new DateParseError('Data OFX inválida', input);
  return build(Number(match[1]), Number(match[2]), Number(match[3]), input);
}

function toUtc(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new DateParseError('Data ISO inválida', iso);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Dias de `from` até `to` (positivo quando `to` é posterior). */
export function diffDays(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / MS_PER_DAY);
}

export function addDays(iso: string, days: number): string {
  const date = new Date(toUtc(iso) + days * MS_PER_DAY);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return parseDate(value, { format: 'YYYY-MM-DD' }) === value;
  } catch {
    return false;
  }
}

export function formatDateBR(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso;
}
