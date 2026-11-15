import { parse } from 'csv-parse/sync';

export type TextEncoding = 'utf-8' | 'windows-1252';
export type Delimiter = ';' | ',' | '\t' | '|';

const BOM = String.fromCharCode(0xfeff);

/** Decodifica texto de arquivo. Em modo automático, tenta UTF-8 estrito e recua para Windows-1252. */
export function decodeText(
  bytes: Uint8Array,
  encoding: 'auto' | TextEncoding,
): { text: string; encoding: TextEncoding } {
  const strip = (text: string) => (text.startsWith(BOM) ? text.slice(1) : text);
  if (encoding === 'windows-1252') {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding };
  }
  try {
    return { text: strip(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), encoding: 'utf-8' };
  } catch (error) {
    if (encoding === 'utf-8') throw new Error('O arquivo não está em UTF-8 válido', { cause: error });
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/** Conta ocorrências do delimitador fora de aspas em uma linha. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) count += 1;
  }
  return count;
}

/**
 * Escolhe o delimitador que aparece de forma mais consistente nas primeiras linhas.
 * A consistência (mesma contagem em todas as linhas) evita confundir vírgula decimal com delimitador.
 */
export function detectDelimiter(text: string): Delimiter {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, 30);
  const candidates: Delimiter[] = [';', '\t', '|', ','];
  let best: Delimiter = ';';
  let bestScore = -1;
  for (const candidate of candidates) {
    const counts = lines.map((line) => countOutsideQuotes(line, candidate));
    const frequency = new Map<number, number>();
    for (const count of counts) if (count > 0) frequency.set(count, (frequency.get(count) ?? 0) + 1);
    let mode = 0;
    let modeLines = 0;
    for (const [count, linesWithCount] of frequency) {
      if (linesWithCount > modeLines || (linesWithCount === modeLines && count > mode)) {
        mode = count;
        modeLines = linesWithCount;
      }
    }
    // linhas concordantes pesam mais que a quantidade de colunas
    const score = modeLines * 1000 + Math.min(mode, 50);
    if (modeLines > 0 && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** Lê CSV em matriz de células de texto. Linhas com número de colunas diferente são aceitas. */
export function parseCsv(text: string, delimiter: Delimiter): string[][] {
  return parse(text, {
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
    bom: true,
    trim: false,
  }) as string[][];
}
