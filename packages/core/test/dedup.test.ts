import { describe, expect, it } from 'vitest';
import { computeDedupKeys, contentHash } from '../src/dedup';

const row = (overrides: Partial<Parameters<typeof computeDedupKeys>[1][number]> = {}) => ({
  date: '2024-01-05',
  amountCents: 10000,
  descriptionNorm: 'PIX RECEBIDO FULANO',
  externalId: null,
  document: null,
  ...overrides,
});

describe('computeDedupKeys', () => {
  it('gera a mesma chave para a mesma transação em arquivos diferentes', () => {
    const [first] = computeDedupKeys('conta-1', [row()]);
    const [again] = computeDedupKeys('conta-1', [row({ date: '2024-01-04' }), row()]).slice(1);
    expect(first?.dedupKey).toBe(again?.dedupKey);
  });

  it('distingue transações idênticas legítimas no mesmo arquivo pelo índice de ocorrência', () => {
    const keys = computeDedupKeys('conta-1', [row(), row(), row()]).map((entry) => entry.dedupKey);
    expect(new Set(keys).size).toBe(3);
    const again = computeDedupKeys('conta-1', [row(), row(), row()]).map((entry) => entry.dedupKey);
    expect(again).toEqual(keys);
  });

  it('separa contas diferentes', () => {
    const [a] = computeDedupKeys('conta-1', [row()]);
    const [b] = computeDedupKeys('conta-2', [row()]);
    expect(a?.dedupKey).not.toBe(b?.dedupKey);
  });

  it('usa o identificador externo quando existe, ignorando variações da descrição', () => {
    const [a] = computeDedupKeys('conta-1', [row({ externalId: 'FIT-1', descriptionNorm: 'A' })]);
    const [b] = computeDedupKeys('conta-1', [row({ externalId: 'FIT-1', descriptionNorm: 'B' })]);
    const [c] = computeDedupKeys('conta-1', [row({ externalId: 'FIT-2', descriptionNorm: 'A' })]);
    expect(a?.dedupKey).toBe(b?.dedupKey);
    expect(a?.dedupKey).not.toBe(c?.dedupKey);
  });

  it('gera chave de semelhança igual para mesma conta, data, valor e descrição com identificadores diferentes', () => {
    const [a] = computeDedupKeys('conta-1', [row({ externalId: 'FIT-1' })]);
    const [b] = computeDedupKeys('conta-1', [row({ externalId: 'FIT-9' })]);
    expect(a?.similarityKey).toBe(b?.similarityKey);
    expect(a?.dedupKey).not.toBe(b?.dedupKey);
  });
});

describe('contentHash', () => {
  it('muda quando valor, data ou descrição mudam', () => {
    const base = contentHash(row());
    expect(contentHash(row())).toBe(base);
    expect(contentHash(row({ amountCents: 10001 }))).not.toBe(base);
    expect(contentHash(row({ date: '2024-01-06' }))).not.toBe(base);
    expect(contentHash(row({ descriptionNorm: 'OUTRA' }))).not.toBe(base);
  });
});
