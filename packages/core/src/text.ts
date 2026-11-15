/**
 * Normalização de descrições e identificadores para comparação.
 * O texto original nunca é alterado; estas funções produzem versões derivadas.
 */

export function normalizeDescription(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Palavras frequentes em extratos que não distinguem uma transação de outra. */
const STOPWORDS = new Set([
  'DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'A', 'O', 'PARA', 'POR', 'COM', 'NO', 'NA',
  'PIX', 'TED', 'DOC', 'TEF', 'TRANSF', 'TRANSFERENCIA', 'PAGAMENTO', 'PAGTO', 'PGTO', 'PAG',
  'RECEBIMENTO', 'RECEBIDO', 'RECEBIDA', 'ENVIADO', 'ENVIADA', 'CREDITO', 'DEBITO', 'CRED', 'DEB',
  'LIQUIDACAO', 'LIQ', 'COBRANCA', 'BOLETO', 'TITULO', 'DEPOSITO', 'DEP', 'SAQUE', 'COMPRA',
  'LTDA', 'ME', 'EPP', 'SA', 'EIRELI', 'CIA', 'REF', 'NF', 'NFE', 'NR', 'NUM', 'NUMERO', 'CONTA',
]);

/** Tokens distintivos de uma descrição já normalizada. */
export function tokenize(normalized: string): string[] {
  const seen = new Set<string>();
  for (const token of normalized.split(' ')) {
    if (token.length < 2 || STOPWORDS.has(token) || /^\d{1,3}$/.test(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/** Identificador comparável: apenas letras e dígitos, maiúsculas, sem zeros à esquerda nas sequências numéricas. */
export function normalizeIdentifier(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const cleaned = String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    // zeros à esquerda de cada sequência numérica: "NF00045" e "NF45" são o mesmo documento
    .replace(/(^|[A-Z])0+(?=\d)/g, '$1');
  return /^0*$/.test(cleaned) ? null : cleaned;
}

const LABELED_REFERENCE =
  /\b(?:NFE|NFSE|NF|NOTA FISCAL|NOTA|DOCUMENTO|DOCTO|DOC|NOSSO NUMERO|NOSSO NRO|BOLETO|TITULO|DUPLICATA|FATURA|FAT|PEDIDO|PED|CONTRATO|REFERENCIA|REF|CHEQUE|CHQ|ID)\s*(?:N|NR|NRO|NUM|NUMERO)?\s*(\d[\d ]{0,3}\d{2,}|\d{2,})\b/g;
const PIX_END_TO_END = /\bE\d{8}\d{12}[A-Z0-9]{11}\b/g;
const LONG_DIGIT_RUN = /\b\d{6,}\b/g;

/**
 * Referências reconhecíveis em uma descrição (nota, documento, nosso número, PIX, números longos),
 * já normalizadas como identificadores e sem repetição.
 */
export function extractReferences(description: string | null | undefined): string[] {
  const normalized = normalizeDescription(description);
  if (normalized === '') return [];
  const found = new Set<string>();

  for (const match of normalized.matchAll(PIX_END_TO_END)) found.add(match[0]);
  for (const match of normalized.matchAll(LABELED_REFERENCE)) {
    const reference = normalizeIdentifier(match[1]);
    if (reference && reference.length >= 3) found.add(reference);
  }
  for (const match of normalized.matchAll(LONG_DIGIT_RUN)) {
    const reference = normalizeIdentifier(match[0]);
    if (reference && reference.length >= 6) found.add(reference);
  }
  return [...found];
}

/** Coeficiente de Dice entre dois conjuntos de tokens (0 a 1). */
export function diceSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return (2 * shared) / (setA.size + setB.size);
}
