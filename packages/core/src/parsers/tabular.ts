import { DateParseError, parseDate } from '../dates';
import type { ImportProfileColumns, ImportProfileConfig } from '../import-profile';
import { AmountParseError, parseAmount, type DecimalSeparator } from '../money';
import { normalizeDescription } from '../text';

export type Cell = string | number | Date | null;

export interface NormalizedRecord {
  /** Linha no arquivo de origem (base 1). */
  rowNumber: number;
  date: string;
  amountCents: number;
  description: string;
  externalId: string | null;
  document: string | null;
  reference: string | null;
  counterparty: string | null;
  dueDate: string | null;
  bankAccountRef: string | null;
  costCenter: string | null;
  category: string | null;
  raw: Record<string, string>;
}

export interface RowRejection {
  rowNumber: number;
  reason: string;
  raw: Record<string, string>;
}

export interface TabularResult {
  headers: string[];
  records: NormalizedRecord[];
  rejections: RowRejection[];
  /** Linhas ignoradas de propósito: saldo, valor zero, linhas sem data e sem valor. */
  skipped: number;
}

export class ImportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportConfigError';
  }
}

const RAW_VALUE_LIMIT = 500;

function cellText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? '' : cell.toISOString().slice(0, 10);
  return String(cell).trim();
}

function isEmpty(cell: Cell | undefined): boolean {
  return cellText(cell) === '';
}

function headerNames(rows: Cell[][], headerRow: number): string[] {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (headerRow === 0) return Array.from({ length: width }, (_, index) => `#${index + 1}`);
  const header = rows[headerRow - 1] ?? [];
  const seen = new Map<string, number>();
  return Array.from({ length: Math.max(width, header.length) }, (_, index) => {
    const base = cellText(header[index]) || `#${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

function resolveColumn(ref: string, headers: string[]): number {
  const positional = /^#(\d+)$/.exec(ref.trim());
  if (positional) {
    const index = Number(positional[1]) - 1;
    if (index < 0 || index >= headers.length) {
      throw new ImportConfigError(`Coluna ${ref} não existe: o arquivo tem ${headers.length} colunas`);
    }
    return index;
  }
  const wanted = normalizeDescription(ref);
  const index = headers.findIndex((header) => normalizeDescription(header) === wanted);
  if (index < 0) {
    throw new ImportConfigError(
      `Coluna "${ref}" não encontrada no arquivo. Colunas disponíveis: ${headers.join(', ')}`,
    );
  }
  return index;
}

/** Decide o separador decimal olhando a coluna inteira, para que "1.234" isolado não seja ambíguo. */
function resolveDecimalSeparator(values: Cell[]): DecimalSeparator {
  let comma = 0;
  let dot = 0;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.replace(/[^\d.,]/g, '');
    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) comma += 1;
      else dot += 1;
    } else if (/,\d{1,2}$/.test(text)) comma += 1;
    else if (/\.\d{1,2}$/.test(text)) dot += 1;
  }
  if (comma > 0 && dot === 0) return ',';
  if (dot > 0 && comma === 0) return '.';
  return 'auto';
}

function optionalText(row: Cell[], index: number | undefined): string | null {
  if (index === undefined) return null;
  const text = cellText(row[index]);
  return text === '' ? null : text;
}

/** Converte linhas de CSV/XLSX em registros normalizados conforme o perfil de importação. */
export function mapTabular(rows: Cell[][], config: ImportProfileConfig): TabularResult {
  const headers = headerNames(rows, config.headerRow);
  const { columns } = config;
  const col = (ref: string | undefined) => (ref === undefined ? undefined : resolveColumn(ref, headers));

  const index = {
    date: resolveColumn(columns.date, headers),
    description: columns.description.map((ref) => resolveColumn(ref, headers)),
    amount: col(columns.amount),
    debit: col(columns.debit),
    credit: col(columns.credit),
    typeColumn: col(columns.typeColumn),
    externalId: col(columns.externalId),
    document: col(columns.document),
    reference: col(columns.reference),
    counterparty: col(columns.counterparty),
    dueDate: col(columns.dueDate),
    bankAccountRef: col(columns.bankAccountRef),
    costCenter: col(columns.costCenter),
    category: col(columns.category),
  };

  const dataRows = rows.slice(config.headerRow);
  const amountIndexes = [index.amount, index.debit, index.credit].filter(
    (value): value is number => value !== undefined,
  );
  const decimalSeparator =
    config.decimalSeparator === 'auto'
      ? resolveDecimalSeparator(dataRows.flatMap((row) => amountIndexes.map((column) => row[column] ?? null)))
      : config.decimalSeparator;

  const debitValues = new Set(config.typeValues.debit.map((value) => normalizeDescription(value) || value));
  const creditValues = new Set(config.typeValues.credit.map((value) => normalizeDescription(value) || value));
  const skipPatterns = config.skipRowPatterns.map((pattern) => normalizeDescription(pattern)).filter(Boolean);
  const dateFormat = config.dateFormat;

  const amountOf = (cell: Cell | undefined): number =>
    typeof cell === 'number' ? parseAmount(cell) : parseAmount(cellText(cell), { decimalSeparator });

  const result: TabularResult = { headers, records: [], rejections: [], skipped: 0 };

  dataRows.forEach((row, offset) => {
    const rowNumber = config.headerRow + offset + 1;
    if (row.every((cell) => isEmpty(cell))) return;

    const raw: Record<string, string> = {};
    headers.forEach((header, column) => {
      const text = cellText(row[column]);
      if (text !== '') raw[header] = text.slice(0, RAW_VALUE_LIMIT);
    });

    const description = index.description
      .map((column) => cellText(row[column]))
      .filter((part) => part !== '')
      .join(' ');
    const descriptionNorm = normalizeDescription(description);
    if (skipPatterns.some((pattern) => descriptionNorm.startsWith(pattern))) {
      result.skipped += 1;
      return;
    }

    const dateCell = row[index.date];
    const amountEmpty = amountIndexes.every((column) => isEmpty(row[column]));
    if (isEmpty(dateCell) && amountEmpty) {
      result.skipped += 1;
      return;
    }

    try {
      if (isEmpty(dateCell)) throw new DateParseError('Linha sem data', dateCell);
      const date =
        typeof dateCell === 'string'
          ? parseDate(dateCell, { format: dateFormat })
          : parseDate(dateCell as number | Date);

      let amountCents: number;
      if (config.amountMode === 'debit_credit') {
        const debitCell = row[index.debit as number];
        const creditCell = row[index.credit as number];
        const debit = isEmpty(debitCell) ? 0 : Math.abs(amountOf(debitCell));
        const credit = isEmpty(creditCell) ? 0 : Math.abs(amountOf(creditCell));
        if (debit !== 0 && credit !== 0) {
          throw new AmountParseError('Linha com débito e crédito preenchidos', null);
        }
        amountCents = credit - debit;
      } else if (config.amountMode === 'type_column') {
        const amountCell = row[index.amount as number];
        if (isEmpty(amountCell)) throw new AmountParseError('Linha sem valor', null);
        const absolute = Math.abs(amountOf(amountCell));
        const typeText = cellText(row[index.typeColumn as number]);
        const type = normalizeDescription(typeText) || typeText;
        if (debitValues.has(type)) amountCents = -absolute;
        else if (creditValues.has(type)) amountCents = absolute;
        else throw new AmountParseError(`Tipo não reconhecido: "${typeText}"`, null);
      } else {
        const amountCell = row[index.amount as number];
        if (isEmpty(amountCell)) throw new AmountParseError('Linha sem valor', null);
        amountCents = amountOf(amountCell);
      }
      if (config.invertSign) amountCents = -amountCents;
      if (amountCents === 0) {
        result.skipped += 1;
        return;
      }

      let dueDate: string | null = null;
      if (index.dueDate !== undefined && !isEmpty(row[index.dueDate])) {
        const dueCell = row[index.dueDate];
        try {
          dueDate =
            typeof dueCell === 'string'
              ? parseDate(dueCell, { format: dateFormat })
              : parseDate(dueCell as number | Date);
        } catch {
          dueDate = null; // vencimento é informativo; não invalida a linha
        }
      }

      result.records.push({
        rowNumber,
        date,
        amountCents,
        description,
        externalId: optionalText(row, index.externalId),
        document: optionalText(row, index.document),
        reference: optionalText(row, index.reference),
        counterparty: optionalText(row, index.counterparty),
        dueDate,
        bankAccountRef: optionalText(row, index.bankAccountRef),
        costCenter: optionalText(row, index.costCenter),
        category: optionalText(row, index.category),
        raw,
      });
    } catch (error) {
      if (error instanceof DateParseError) {
        result.rejections.push({ rowNumber, reason: `Data inválida: ${error.message}`, raw });
      } else if (error instanceof AmountParseError) {
        result.rejections.push({ rowNumber, reason: `Valor inválido: ${error.message}`, raw });
      } else {
        throw error;
      }
    }
  });

  return result;
}

// ---------------------------------------------------------------------------
// Sugestão heurística de mapeamento (determinística; não usa IA)
// ---------------------------------------------------------------------------

type FieldKey = keyof ImportProfileColumns;

interface FieldHint {
  field: Exclude<FieldKey, 'description'> | 'description';
  exact: string[];
  contains: string[];
  /** Cabeçalhos que contêm estes termos não servem para o campo. */
  exclude?: string[];
}

const FIELD_HINTS: FieldHint[] = [
  {
    field: 'dueDate',
    exact: ['VENCIMENTO', 'DATA VENCIMENTO', 'DT VENCIMENTO', 'VENC', 'DATA DE VENCIMENTO'],
    contains: ['VENCIMENTO'],
  },
  {
    field: 'date',
    exact: [
      'DATA', 'DT', 'DATE', 'DATA LANCAMENTO', 'DATA MOVIMENTO', 'DATA MOV', 'DATA PAGAMENTO', 'DATA BAIXA',
      'DATA LIQUIDACAO', 'DATA OPERACAO', 'DATA TRANSACAO', 'DATA CREDITO', 'DATA DO LANCAMENTO',
      'DATA DE PAGAMENTO', 'DATA DA BAIXA', 'DATA MOVIMENTACAO',
    ],
    contains: ['DATA'],
    exclude: ['VENCIMENTO', 'EMISSAO', 'COMPETENCIA', 'CADASTRO'],
  },
  {
    field: 'debit',
    exact: ['DEBITO', 'DEBITOS', 'SAIDA', 'SAIDAS', 'VALOR DEBITO', 'DEBITO R'],
    contains: ['DEBITO', 'SAIDA'],
    exclude: ['CREDITO'],
  },
  {
    field: 'credit',
    exact: ['CREDITO', 'CREDITOS', 'ENTRADA', 'ENTRADAS', 'VALOR CREDITO', 'CREDITO R'],
    contains: ['CREDITO', 'ENTRADA'],
    exclude: ['DEBITO'],
  },
  {
    field: 'amount',
    exact: [
      'VALOR', 'VALOR R', 'VLR', 'AMOUNT', 'MONTANTE', 'VALOR LANCAMENTO', 'VALOR PAGO', 'VALOR LIQUIDO',
      'VALOR TOTAL', 'VALOR DO LANCAMENTO',
    ],
    contains: ['VALOR'],
    exclude: ['DEBITO', 'CREDITO', 'SALDO'],
  },
  {
    field: 'description',
    exact: [
      'HISTORICO', 'DESCRICAO', 'LANCAMENTO', 'MEMO', 'DESCRIPTION', 'DETALHE', 'DETALHES',
      'HISTORICO LANCAMENTO', 'HISTORICO DO LANCAMENTO', 'OBSERVACAO',
    ],
    contains: ['HISTORICO', 'DESCRICAO', 'DESCR'],
  },
  {
    field: 'document',
    exact: [
      'DOCUMENTO', 'DOC', 'N DOCUMENTO', 'NR DOCUMENTO', 'NUMERO DOCUMENTO', 'NUM DOCUMENTO', 'N DOC',
      'NRO DOC', 'NOTA FISCAL', 'NF', 'CHEQUE', 'DOCTO', 'NUMERO DO DOCUMENTO',
    ],
    contains: ['DOCUMENTO', 'DOCTO'],
  },
  {
    field: 'externalId',
    exact: [
      'ID', 'CODIGO', 'IDENTIFICADOR', 'ID LANCAMENTO', 'ID TRANSACAO', 'CHAVE', 'COD', 'CODIGO LANCAMENTO',
      'SEQUENCIAL', 'ID DO LANCAMENTO',
    ],
    contains: ['IDENTIFICADOR'],
  },
  {
    field: 'reference',
    exact: ['REFERENCIA', 'REF', 'NOSSO NUMERO', 'NOSSO NRO'],
    contains: ['REFERENCIA', 'NOSSO NUMERO'],
  },
  {
    field: 'counterparty',
    exact: [
      'FAVORECIDO', 'CLIENTE', 'FORNECEDOR', 'PAGADOR', 'BENEFICIARIO', 'NOME', 'RAZAO SOCIAL',
      'CLIENTE FORNECEDOR', 'PARCEIRO', 'CONTRAPARTE',
    ],
    contains: ['FORNECEDOR', 'CLIENTE', 'FAVORECIDO', 'BENEFICIARIO'],
  },
  {
    field: 'typeColumn',
    exact: ['TIPO', 'D C', 'DC', 'NATUREZA', 'TIPO LANCAMENTO', 'TIPO OPERACAO', 'DEBITO CREDITO'],
    contains: [],
  },
  {
    field: 'bankAccountRef',
    exact: ['CONTA', 'CONTA BANCARIA', 'BANCO', 'CONTA CORRENTE'],
    contains: ['CONTA BANCARIA'],
  },
  {
    field: 'costCenter',
    exact: ['CENTRO DE CUSTO', 'CENTRO CUSTO', 'CC'],
    contains: ['CENTRO DE CUSTO'],
  },
  {
    field: 'category',
    exact: ['CATEGORIA', 'PLANO DE CONTAS', 'CONTA CONTABIL', 'NATUREZA FINANCEIRA'],
    contains: ['CATEGORIA'],
  },
];

function hintScore(header: string, hint: FieldHint): number {
  if (header === '') return 0;
  if (hint.exclude?.some((term) => header.includes(term))) return 0;
  if (hint.exact.includes(header)) return 3;
  if (hint.exact.some((name) => header.startsWith(`${name} `))) return 2;
  if (hint.contains.some((term) => ` ${header} `.includes(` ${term} `) || header.includes(term))) return 1;
  return 0;
}

function recognizedCount(row: Cell[]): number {
  let count = 0;
  for (const cell of row) {
    const header = normalizeDescription(cellText(cell));
    if (FIELD_HINTS.some((hint) => hintScore(header, hint) >= 2)) count += 1;
  }
  return count;
}

export interface MappingSuggestion {
  headerRow: number;
  headers: string[];
  amountMode: ImportProfileConfig['amountMode'];
  columns: Partial<ImportProfileColumns>;
  /** Campos obrigatórios que a heurística não conseguiu preencher. */
  missing: string[];
  method: 'heuristica-local';
}

const DEFAULT_TYPE_VOCABULARY = new Set([
  'D', 'C', 'DEBITO', 'CREDITO', 'ENTRADA', 'SAIDA', 'PAGAR', 'RECEBER', 'PAGAMENTO', 'RECEBIMENTO',
  'DESPESA', 'RECEITA',
]);

/** Sugere linha de cabeçalho e mapeamento de colunas a partir de nomes usuais. O usuário confirma ou corrige. */
export function suggestMapping(rows: Cell[][], _sourceKind: 'bank' | 'ledger'): MappingSuggestion {
  let headerRow = 1;
  let best = 0;
  rows.slice(0, 30).forEach((row, index) => {
    const count = recognizedCount(row);
    if (count > best) {
      best = count;
      headerRow = index + 1;
    }
  });
  if (best < 2) headerRow = rows.length > 0 ? 1 : 0;

  const headers = headerNames(rows, headerRow);
  const normalized = headers.map((header) => normalizeDescription(header));
  const used = new Set<number>();
  const chosen: Partial<Record<FieldHint['field'], string>> = {};

  for (const minimum of [3, 2, 1]) {
    for (const hint of FIELD_HINTS) {
      if (chosen[hint.field] !== undefined) continue;
      let bestIndex = -1;
      let bestScore = 0;
      normalized.forEach((header, index) => {
        if (used.has(index)) return;
        const score = hintScore(header, hint);
        if (score >= minimum && score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });
      if (bestIndex >= 0) {
        used.add(bestIndex);
        chosen[hint.field] = headers[bestIndex];
      }
    }
  }

  const columns: Partial<ImportProfileColumns> = {};
  if (chosen.date) columns.date = chosen.date;
  if (chosen.description) columns.description = [chosen.description];
  for (const field of [
    'externalId', 'document', 'reference', 'counterparty', 'dueDate', 'bankAccountRef', 'costCenter', 'category',
  ] as const) {
    const header = chosen[field];
    if (header) columns[field] = header;
  }

  let amountMode: ImportProfileConfig['amountMode'] = 'signed';
  if (chosen.debit && chosen.credit) {
    amountMode = 'debit_credit';
    columns.debit = chosen.debit;
    columns.credit = chosen.credit;
  } else {
    const amountHeader = chosen.amount ?? chosen.credit ?? chosen.debit;
    if (amountHeader) columns.amount = amountHeader;
    if (chosen.typeColumn && amountHeader) {
      const typeIndex = headers.indexOf(chosen.typeColumn);
      const samples = rows
        .slice(headerRow, headerRow + 50)
        .map((row) => normalizeDescription(cellText(row[typeIndex])))
        .filter((value) => value !== '');
      if (samples.length > 0 && samples.every((value) => DEFAULT_TYPE_VOCABULARY.has(value))) {
        amountMode = 'type_column';
        columns.typeColumn = chosen.typeColumn;
      }
    }
  }

  const missing: string[] = [];
  if (!columns.date) missing.push('date');
  if (!columns.description) missing.push('description');
  if (amountMode === 'debit_credit' ? !columns.debit || !columns.credit : !columns.amount) missing.push('amount');

  return { headerRow, headers, amountMode, columns, missing, method: 'heuristica-local' };
}
