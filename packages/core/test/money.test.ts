import { describe, expect, it } from 'vitest';
import { AmountParseError, formatBRL, formatDecimalBR, parseAmount } from '../src/money';

describe('parseAmount', () => {
  it.each([
    ['1.234,56', 123456],
    ['1234,56', 123456],
    ['0,05', 5],
    ['-1.234,56', -123456],
    ['1.234,56-', -123456],
    ['(1.234,56)', -123456],
    ['R$ 1.234,56', 123456],
    ['R$\u00a0-10,00', -1000],
    ['+45,90', 4590],
    ['1.234,56 D', -123456],
    ['1.234,56 C', 123456],
    ['1,234.56', 123456],
    ['1234.56', 123456],
    ['-150.00', -15000],
    ['100', 10000],
    ['12,5', 1250],
    ['1.234.567,89', 123456789],
  ])('lê "%s" como %d centavos', (input, cents) => {
    expect(parseAmount(input)).toBe(cents);
  });

  it('respeita o separador decimal explícito quando o valor seria ambíguo', () => {
    expect(parseAmount('1.234', { decimalSeparator: ',' })).toBe(123400);
    expect(parseAmount('1,234', { decimalSeparator: '.' })).toBe(123400);
  });

  it('recusa valor ambíguo em modo automático', () => {
    expect(() => parseAmount('1.234')).toThrow(AmountParseError);
    expect(() => parseAmount('1,234')).toThrow(AmountParseError);
  });

  it('converte número de planilha sem erro de ponto flutuante', () => {
    expect(parseAmount(1234.56)).toBe(123456);
    expect(parseAmount(-0.1 - 0.2)).toBe(-30);
    expect(parseAmount(1.005)).toBe(101);
    expect(parseAmount(19.99)).toBe(1999);
  });

  it.each(['', '   ', 'abc', '12,34,56', '1.2.3', '10,555', '--5', 'NaN'])('recusa "%s"', (input) => {
    expect(() => parseAmount(input)).toThrow(AmountParseError);
  });

  it('recusa número não finito', () => {
    expect(() => parseAmount(Number.NaN)).toThrow(AmountParseError);
    expect(() => parseAmount(Number.POSITIVE_INFINITY)).toThrow(AmountParseError);
  });
});

describe('formatação', () => {
  it('formata em reais', () => {
    expect(formatBRL(123456)).toBe('R$ 1.234,56');
    expect(formatBRL(-5)).toBe('-R$ 0,05');
    expect(formatBRL(0)).toBe('R$ 0,00');
    expect(formatBRL(100000000)).toBe('R$ 1.000.000,00');
  });

  it('formata decimal sem símbolo para arquivos', () => {
    expect(formatDecimalBR(-123456)).toBe('-1234,56');
    expect(formatDecimalBR(7)).toBe('0,07');
  });
});
