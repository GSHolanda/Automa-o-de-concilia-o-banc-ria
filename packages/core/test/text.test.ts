import { describe, expect, it } from 'vitest';
import {
  diceSimilarity,
  extractReferences,
  normalizeDescription,
  normalizeIdentifier,
  tokenize,
} from '../src/text';

describe('normalizeDescription', () => {
  it('remove acentos, pontuação e espaços repetidos e põe em maiúsculas', () => {
    expect(normalizeDescription('  Pagto.  Fornecedor:  Açúcar & Cia. Ltda  ')).toBe(
      'PAGTO FORNECEDOR ACUCAR CIA LTDA',
    );
  });

  it('devolve texto vazio para entrada vazia ou nula', () => {
    expect(normalizeDescription('')).toBe('');
    expect(normalizeDescription(null)).toBe('');
    expect(normalizeDescription(undefined)).toBe('');
  });
});

describe('tokenize', () => {
  it('descarta palavras genéricas de extrato e tokens de um caractere', () => {
    expect(tokenize('PIX RECEBIDO DE PADARIA BOM PAO LTDA')).toEqual(['PADARIA', 'BOM', 'PAO']);
  });
});

describe('normalizeIdentifier', () => {
  it('mantém apenas letras e dígitos, sem zeros à esquerda', () => {
    expect(normalizeIdentifier('000.123-4/A')).toBe('1234A');
    expect(normalizeIdentifier('nf-00045')).toBe('NF45');
  });

  it('devolve nulo quando não sobra conteúdo', () => {
    expect(normalizeIdentifier('  ')).toBeNull();
    expect(normalizeIdentifier('000')).toBeNull();
    expect(normalizeIdentifier(null)).toBeNull();
  });
});

describe('extractReferences', () => {
  it('extrai número rotulado de nota, documento e boleto', () => {
    expect(extractReferences('PAGAMENTO NF 004512 FORNECEDOR X')).toContain('4512');
    expect(extractReferences('TED DOC: 778899 CLIENTE Y')).toContain('778899');
    expect(extractReferences('LIQ BOLETO NOSSO NUMERO 000012345678')).toContain('12345678');
  });

  it('extrai identificador fim a fim de PIX', () => {
    const e2e = 'E12345678202401051234ABCDEFGHIJK';
    expect(extractReferences(`PIX RECEBIDO ${e2e} FULANO`)).toContain(e2e);
  });

  it('extrai sequências longas de dígitos', () => {
    expect(extractReferences('COBRANCA 20240000123 CLIENTE')).toContain('20240000123');
  });

  it('ignora números curtos sem rótulo', () => {
    expect(extractReferences('TARIFA PACOTE 12 MENSAL')).toEqual([]);
  });

  it('não repete referências', () => {
    expect(extractReferences('NF 4512 REF NF 4512')).toEqual(['4512']);
  });
});

describe('diceSimilarity', () => {
  it('vale 1 para conjuntos iguais e 0 para disjuntos', () => {
    expect(diceSimilarity(['A', 'B'], ['B', 'A'])).toBe(1);
    expect(diceSimilarity(['A'], ['B'])).toBe(0);
  });

  it('vale 0 quando algum lado é vazio', () => {
    expect(diceSimilarity([], ['A'])).toBe(0);
    expect(diceSimilarity([], [])).toBe(0);
  });

  it('é proporcional à interseção', () => {
    expect(diceSimilarity(['A', 'B', 'C'], ['A', 'B', 'D'])).toBeCloseTo(2 / 3, 5);
  });
});
