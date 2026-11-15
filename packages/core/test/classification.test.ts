import { describe, expect, it } from 'vitest';
import { DEFAULT_CLASSIFICATION_RULES, classify, type ClassificationRule } from '../src/classification';

const item = (description: string, amountCents: number, side: 'bank' | 'ledger' = 'bank') => ({
  side,
  descriptionNorm: description,
  amountCents,
});

describe('classify com regras padrão', () => {
  it.each([
    ['TARIFA PACOTE SERVICOS', -3590, 'fee'],
    ['TAR MANUT CONTA', -1200, 'fee'],
    ['IOF', -310, 'tax'],
    ['JUROS CHEQUE ESPECIAL', -4500, 'interest'],
    ['ESTORNO TARIFA PACOTE', 3590, 'reversal'],
    ['DEVOLUCAO PIX FULANO', 10000, 'reversal'],
    ['TRANSF ENTRE CONTAS MESMA TITULARIDADE', -100000, 'internal_transfer'],
    ['PIX RECEBIDO PADARIA BOM PAO', 150000, 'regular'],
  ])('"%s" (%d) é %s', (description, amount, kind) => {
    expect(classify(item(description, amount), DEFAULT_CLASSIFICATION_RULES).kind).toBe(kind);
  });

  it('compara por palavra inteira: TAR não casa com GUITARRA nem TARDE', () => {
    expect(classify(item('COMPRA GUITARRA LOJA', -90000), DEFAULT_CLASSIFICATION_RULES).kind).toBe('regular');
    expect(classify(item('BOA TARDE PADARIA', -900), DEFAULT_CLASSIFICATION_RULES).kind).toBe('regular');
  });

  it('informa a regra aplicada', () => {
    const result = classify(item('IOF', -310), DEFAULT_CLASSIFICATION_RULES);
    expect(result.ruleName).toMatch(/IOF/i);
  });
});

describe('classify com regras da empresa', () => {
  const rule = (overrides: Partial<ClassificationRule>): ClassificationRule => ({
    name: 'regra',
    priority: 100,
    matchType: 'contains',
    pattern: 'X',
    appliesTo: 'both',
    direction: 'any',
    resultKind: 'fee',
    categoryId: null,
    active: true,
    ...overrides,
  });

  it('aplica a regra de menor prioridade numérica primeiro', () => {
    const rules = [
      rule({ name: 'b', priority: 20, pattern: 'TAXA', resultKind: 'fee' }),
      rule({ name: 'a', priority: 10, pattern: 'TAXA CARTAO', resultKind: 'regular' }),
    ];
    expect(classify(item('TAXA CARTAO MAQUININHA', -500), rules)).toMatchObject({ kind: 'regular', ruleName: 'a' });
  });

  it('respeita direção, lado e situação da regra', () => {
    const rules = [
      rule({ name: 'so-debito', pattern: 'SEGURO', direction: 'debit', resultKind: 'fee' }),
      rule({ name: 'so-ledger', pattern: 'AJUSTE', appliesTo: 'ledger', resultKind: 'tax' }),
      rule({ name: 'inativa', pattern: 'INATIVA', active: false }),
    ];
    expect(classify(item('SEGURO PRESTAMISTA', -100), rules).kind).toBe('fee');
    expect(classify(item('SEGURO PRESTAMISTA', 100), rules).kind).toBe('regular');
    expect(classify(item('AJUSTE', -100, 'bank'), rules).kind).toBe('regular');
    expect(classify(item('AJUSTE', -100, 'ledger'), rules).kind).toBe('tax');
    expect(classify(item('INATIVA', -100), rules).kind).toBe('regular');
  });

  it('suporta início, igualdade e todas as palavras', () => {
    expect(classify(item('DEB AUT SEGURO', -1), [rule({ matchType: 'starts_with', pattern: 'deb aut' })]).kind).toBe('fee');
    expect(classify(item('X DEB AUT', -1), [rule({ matchType: 'starts_with', pattern: 'DEB AUT' })]).kind).toBe('regular');
    expect(classify(item('IOF', -1), [rule({ matchType: 'equals', pattern: 'iof' })]).kind).toBe('fee');
    expect(classify(item('IOF ADICIONAL', -1), [rule({ matchType: 'equals', pattern: 'IOF' })]).kind).toBe('regular');
    expect(classify(item('TAXA DE ANTECIPACAO CARTAO', -1), [rule({ matchType: 'contains_all', pattern: 'cartão taxa' })]).kind).toBe('fee');
  });

  it('devolve a categoria da regra', () => {
    const result = classify(item('TARIFA', -1), [rule({ pattern: 'TARIFA', categoryId: 'cat-1' })]);
    expect(result.categoryId).toBe('cat-1');
  });
});
