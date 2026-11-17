import { badRequest } from './errors';

/**
 * Cursor de paginação por (created_at, id), em ordem decrescente. O instante vai como texto do
 * PostgreSQL (`created_at::text`) para preservar os microssegundos que o Date do JavaScript perde.
 */
export interface TimeCursor {
  at: string;
  id: string;
}

export function encodeTimeCursor(cursor: TimeCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), 'utf8').toString('base64url');
}

export function decodeTimeCursor(value: string): TimeCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      if (/^[0-9a-f-]{36}$/i.test(parsed[1]) && parsed[0].length <= 64) return { at: parsed[0], id: parsed[1] };
    }
  } catch {
    // segue para o erro abaixo
  }
  throw badRequest('Cursor de paginação inválido.', 'invalid_cursor');
}
