import { z } from 'zod';

/** Referência de coluna: nome do cabeçalho ou posição no formato "#3" (base 1). */
export const columnRefSchema = z.string().trim().min(1).max(120);

export const importProfileColumnsSchema = z.object({
  date: columnRefSchema,
  description: z.array(columnRefSchema).min(1).max(5),
  amount: columnRefSchema.optional(),
  debit: columnRefSchema.optional(),
  credit: columnRefSchema.optional(),
  typeColumn: columnRefSchema.optional(),
  externalId: columnRefSchema.optional(),
  document: columnRefSchema.optional(),
  reference: columnRefSchema.optional(),
  counterparty: columnRefSchema.optional(),
  dueDate: columnRefSchema.optional(),
  bankAccountRef: columnRefSchema.optional(),
  costCenter: columnRefSchema.optional(),
  category: columnRefSchema.optional(),
});

export const DEFAULT_SKIP_ROW_PATTERNS = [
  'SALDO ANTERIOR',
  'SALDO DO DIA',
  'SALDO DIA',
  'SALDO FINAL',
  'SALDO ATUAL',
  'SALDO DISPONIVEL',
  'SALDO BLOQUEADO',
  'S A L D O',
];

export const importProfileConfigSchema = z
  .object({
    delimiter: z.enum(['auto', ';', ',', 'tab', '|']).default('auto'),
    encoding: z.enum(['auto', 'utf-8', 'windows-1252']).default('auto'),
    sheetName: z.string().trim().max(100).nullable().default(null),
    /** Linha do cabeçalho (base 1). Zero indica arquivo sem cabeçalho; use colunas "#N". */
    headerRow: z.number().int().min(0).max(200).default(1),
    dateFormat: z.enum(['auto', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'YYYYMMDD']).default('auto'),
    decimalSeparator: z.enum(['auto', ',', '.']).default('auto'),
    /** signed: uma coluna com sinal; debit_credit: duas colunas; type_column: valor absoluto + indicador. */
    amountMode: z.enum(['signed', 'debit_credit', 'type_column']).default('signed'),
    invertSign: z.boolean().default(false),
    columns: importProfileColumnsSchema,
    typeValues: z
      .object({
        debit: z.array(z.string().trim().min(1).max(40)).max(20),
        credit: z.array(z.string().trim().min(1).max(40)).max(20),
      })
      .default({
        debit: ['D', 'DEBITO', 'SAIDA', 'PAGAR', 'PAGAMENTO', 'DESPESA', '-'],
        credit: ['C', 'CREDITO', 'ENTRADA', 'RECEBER', 'RECEBIMENTO', 'RECEITA', '+'],
      }),
    /** Linhas cuja descrição normalizada começa com um destes textos são ignoradas (linhas de saldo). */
    skipRowPatterns: z.array(z.string().trim().min(1).max(80)).max(30).default(DEFAULT_SKIP_ROW_PATTERNS),
  })
  .superRefine((config, context) => {
    const { columns, amountMode } = config;
    if (amountMode === 'signed' && !columns.amount) {
      context.addIssue({ code: 'custom', path: ['columns', 'amount'], message: 'Informe a coluna de valor' });
    }
    if (amountMode === 'debit_credit' && (!columns.debit || !columns.credit)) {
      context.addIssue({
        code: 'custom',
        path: ['columns', 'debit'],
        message: 'Informe as colunas de débito e de crédito',
      });
    }
    if (amountMode === 'type_column' && (!columns.amount || !columns.typeColumn)) {
      context.addIssue({
        code: 'custom',
        path: ['columns', 'typeColumn'],
        message: 'Informe a coluna de valor e a coluna de tipo',
      });
    }
  });

export type ImportProfileConfig = z.infer<typeof importProfileConfigSchema>;
export type ImportProfileConfigInput = z.input<typeof importProfileConfigSchema>;
export type ImportProfileColumns = z.infer<typeof importProfileColumnsSchema>;
