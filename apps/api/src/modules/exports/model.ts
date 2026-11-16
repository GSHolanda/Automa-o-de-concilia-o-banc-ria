/** Modelo neutro de relatório, comum a CSV, XLSX e PDF. */
export type CellKind = 'text' | 'date' | 'money' | 'int';
/** Texto, data civil (AAAA-MM-DD), centavos ou inteiro; nulo = vazio. */
export type Cell = string | number | null;

export interface Column {
  key: string;
  label: string;
  kind: CellKind;
  /** Largura relativa no PDF e em caracteres no XLSX. */
  width: number;
}

export interface Total {
  label: string;
  value: number;
  kind: 'int' | 'money';
}

export interface Section {
  /** Nome da aba (XLSX) e subtítulo (PDF). */
  title: string;
  columns: Column[];
  rows: Cell[][];
  totals: Total[];
}

export interface Report {
  title: string;
  company: string;
  /** Linhas descritivas: período, conta, filtros. */
  subtitle: string[];
  generatedAt: Date;
  generatedBy: string;
  footer: string;
  sections: Section[];
}
