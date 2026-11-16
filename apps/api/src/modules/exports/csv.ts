import { formatDateBR, formatDecimalBR } from '@concilia/core';
import type { Cell, Column, Section } from './model';

/** Texto iniciado por =, +, -, @, tabulação ou CR é lido como fórmula por planilhas: recebe `'` à frente. */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function cellText(column: Column, value: Cell): string {
  if (value === null || value === '') return '';
  if (column.kind === 'money' && typeof value === 'number') return formatDecimalBR(value);
  if (column.kind === 'int') return String(value);
  if (column.kind === 'date' && typeof value === 'string') return formatDateBR(value);
  return neutralizeFormula(String(value));
}

/** Marca de ordem de bytes UTF-8 (U+FEFF), para o Excel reconhecer a codificação. */
const BOM = String.fromCharCode(0xfeff);

function quote(text: string): string {
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV em UTF-8 com BOM, separador `;` e fim de linha CRLF. Só a primeira seção (os totais ficam fora, para leitura por máquina). */
export function renderCsv(section: Section): Buffer {
  const lines = [section.columns.map((column) => quote(column.label)).join(';')];
  for (const row of section.rows) {
    lines.push(row.map((value, index) => quote(cellText(section.columns[index]!, value))).join(';'));
  }
  return Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8');
}
