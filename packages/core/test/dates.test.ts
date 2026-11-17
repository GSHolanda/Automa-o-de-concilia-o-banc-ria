import { describe, expect, it } from 'vitest';
import { DateParseError, addDays, diffDays, formatDateBR, parseDate, parseOfxDate } from '../src/dates';

describe('parseDate', () => {
  it.each([
    ['05/01/2024', '2024-01-05'],
    ['5/1/2024', '2024-01-05'],
    ['05/01/24', '2024-01-05'],
    ['31/12/99', '1999-12-31'],
    ['05-01-2024', '2024-01-05'],
    ['05.01.2024', '2024-01-05'],
    ['2024-01-05', '2024-01-05'],
    ['2024-01-05T13:45:00Z', '2024-01-05'],
    ['2024-01-05 13:45:00', '2024-01-05'],
    ['20240105', '2024-01-05'],
    [' 29/02/2024 ', '2024-02-29'],
  ])('lê "%s" como %s', (input, iso) => {
    expect(parseDate(input)).toBe(iso);
  });

  it('usa o formato explícito mês/dia quando informado', () => {
    expect(parseDate('01/05/2024', { format: 'MM/DD/YYYY' })).toBe('2024-01-05');
  });

  it('lê objeto Date pelas partes UTC, como entregue por planilhas', () => {
    expect(parseDate(new Date(Date.UTC(2024, 0, 5)))).toBe('2024-01-05');
  });

  it('lê número serial de planilha', () => {
    expect(parseDate(45296)).toBe('2024-01-05');
  });

  it.each(['', '31/02/2024', '00/01/2024', '2024-13-01', '32/01/2024', 'ontem', '29/02/2023'])(
    'recusa "%s"',
    (input) => {
      expect(() => parseDate(input)).toThrow(DateParseError);
    },
  );
});

describe('parseOfxDate', () => {
  it.each([
    ['20240105', '2024-01-05'],
    ['20240105120000', '2024-01-05'],
    ['20240105000000[-3:BRT]', '2024-01-05'],
    ['20240105235959.000[-03:EST]', '2024-01-05'],
  ])('lê "%s" como data civil %s, sem converter fuso', (input, iso) => {
    expect(parseOfxDate(input)).toBe(iso);
  });

  it('recusa data OFX inválida', () => {
    expect(() => parseOfxDate('2024')).toThrow(DateParseError);
    expect(() => parseOfxDate('20241301')).toThrow(DateParseError);
  });
});

describe('aritmética de datas', () => {
  it('calcula diferença em dias com sinal', () => {
    expect(diffDays('2024-01-05', '2024-01-08')).toBe(3);
    expect(diffDays('2024-03-01', '2024-02-28')).toBe(-2);
    expect(diffDays('2023-12-31', '2024-01-01')).toBe(1);
  });

  it('soma dias atravessando mês e ano', () => {
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addDays('2024-01-01', -1)).toBe('2023-12-31');
  });

  it('formata no padrão brasileiro', () => {
    expect(formatDateBR('2024-01-05')).toBe('05/01/2024');
  });
});
