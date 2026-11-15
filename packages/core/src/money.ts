/**
 * Valores monetários em centavos inteiros.
 * Entrada de recursos é positiva; saída é negativa.
 */

export class AmountParseError extends Error {
  constructor(
    message: string,
    readonly input: unknown,
  ) {
    super(message);
    this.name = 'AmountParseError';
  }
}

export type DecimalSeparator = 'auto' | ',' | '.';

export interface ParseAmountOptions {
  decimalSeparator?: DecimalSeparator;
}

function toSafeCents(value: number, input: unknown): number {
  if (!Number.isSafeInteger(value)) throw new AmountParseError('Valor fora do intervalo suportado', input);
  return value === 0 ? 0 : value;
}

/** Converte texto ou número em centavos. Lança AmountParseError quando não é possível decidir com segurança. */
export function parseAmount(input: string | number, options: ParseAmountOptions = {}): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new AmountParseError('Valor numérico inválido', input);
    // toPrecision(15) elimina o resíduo binário (ex.: 1.005 * 100 = 100.49999999999999).
    return toSafeCents(Math.round(Number((input * 100).toPrecision(15))), input);
  }

  let text = String(input ?? '')
    .replace(/[\s\u00a0]/g, '')
    .replace(/^R\$/i, '')
    .replace(/R\$/gi, '');
  if (text === '') throw new AmountParseError('Valor vazio', input);

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  const suffix = /[DC]$/i.exec(text);
  if (suffix) {
    if (suffix[0].toUpperCase() === 'D') negative = true;
    text = text.slice(0, -1);
  }
  if (text.endsWith('-')) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }

  if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) throw new AmountParseError('Valor não numérico', input);

  let separator = options.decimalSeparator ?? 'auto';
  if (separator === 'auto') {
    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      separator = lastComma > lastDot ? ',' : '.';
    } else if (lastComma >= 0 || lastDot >= 0) {
      const char = lastComma >= 0 ? ',' : '.';
      const grouped = new RegExp(`^\\d{1,3}(\\${char}\\d{3})+$`);
      if (grouped.test(text)) {
        throw new AmountParseError(
          'Valor ambíguo: defina o separador decimal no perfil de importação',
          input,
        );
      }
      separator = char;
    } else {
      separator = ',';
    }
  }

  const thousands = separator === ',' ? '.' : ',';
  const parts = text.split(separator);
  if (parts.length > 2) throw new AmountParseError('Mais de um separador decimal', input);
  const integerRaw = parts[0] ?? '';
  const fraction = parts[1] ?? '';
  if (fraction.includes(thousands)) throw new AmountParseError('Separadores em posição inválida', input);

  let integer = integerRaw;
  if (integerRaw.includes(thousands)) {
    const groupedInteger = new RegExp(`^\\d{1,3}(\\${thousands}\\d{3})+$`);
    if (!groupedInteger.test(integerRaw)) throw new AmountParseError('Separador de milhar em posição inválida', input);
    integer = integerRaw.split(thousands).join('');
  }
  if (!/^\d*$/.test(integer) || !/^\d*$/.test(fraction) || (integer === '' && fraction === '')) {
    throw new AmountParseError('Valor não numérico', input);
  }
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) {
    throw new AmountParseError('Valor com mais de duas casas decimais', input);
  }

  const cents = Number(integer || '0') * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
  return toSafeCents(negative ? -cents : cents, input);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** "R$ 1.234,56" — independente de Intl para ser idêntico em qualquer ambiente. */
export function formatBRL(cents: number): string {
  const abs = Math.abs(cents);
  const integer = Math.floor(abs / 100).toString();
  const fraction = (abs % 100).toString().padStart(2, '0');
  return `${cents < 0 ? '-' : ''}R$ ${groupThousands(integer)},${fraction}`;
}

/** "-1234,56" — para colunas numéricas em CSV. */
export function formatDecimalBR(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)},${(abs % 100).toString().padStart(2, '0')}`;
}
