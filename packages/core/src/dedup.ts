import { createHash } from 'node:crypto';
import { normalizeIdentifier } from './text';

export interface DedupInput {
  date: string;
  amountCents: number;
  descriptionNorm: string;
  externalId: string | null;
  document: string | null;
}

export interface DedupKeys {
  /** Identidade da transação: igual em qualquer reimportação do mesmo conteúdo. */
  dedupKey: string;
  /** Mesma conta, data, valor e descrição, ignorando identificadores: indica possível duplicidade. */
  similarityKey: string;
}

const VERSION = 'v1';

function sha256(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

/**
 * Calcula as chaves de deduplicação de um arquivo, na ordem das linhas.
 *
 * Transações idênticas no mesmo arquivo recebem índice de ocorrência (0, 1, 2…): duas vendas iguais no
 * mesmo dia continuam sendo duas, e reimportar o arquivo gera exatamente as mesmas chaves.
 */
export function computeDedupKeys(scope: string, rows: readonly DedupInput[]): DedupKeys[] {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const externalId = normalizeIdentifier(row.externalId);
    const identity = externalId
      ? sha256([VERSION, scope, 'id', externalId, row.date, row.amountCents])
      : sha256([
          VERSION,
          scope,
          'content',
          row.date,
          row.amountCents,
          row.descriptionNorm,
          normalizeIdentifier(row.document) ?? '',
        ]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return {
      dedupKey: sha256([identity, occurrence]),
      similarityKey: sha256([VERSION, scope, 'similar', row.date, row.amountCents, row.descriptionNorm]),
    };
  });
}

/** Resumo do conteúdo relevante de um registro, para detectar alteração na origem. */
export function contentHash(row: DedupInput): string {
  return sha256([
    VERSION,
    row.date,
    row.amountCents,
    row.descriptionNorm,
    normalizeIdentifier(row.document) ?? '',
  ]);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
