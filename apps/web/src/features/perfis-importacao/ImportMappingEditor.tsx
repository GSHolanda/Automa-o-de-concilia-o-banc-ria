import type { ImportProfileConfig } from '@concilia/core/shared';
import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { Field } from '../../components/Field';
import { Select } from '../../components/Select';
import { NumberField, rangeError } from '../configuracoes/NumberField';

export type ImportMappingValue = ImportProfileConfig;
type Columns = ImportProfileConfig['columns'];
type SingleColumn = Exclude<keyof Columns, 'description'>;

export const DEFAULT_SKIP_ROW_PATTERNS = [
  'SALDO ANTERIOR', 'SALDO DO DIA', 'SALDO DIA', 'SALDO FINAL', 'SALDO ATUAL', 'SALDO DISPONIVEL', 'SALDO BLOQUEADO', 'S A L D O',
];

/** Configuração inicial de um perfil novo (mesmos padrões do servidor). */
export function defaultImportMapping(): ImportMappingValue {
  return {
    delimiter: 'auto',
    encoding: 'auto',
    sheetName: null,
    headerRow: 1,
    dateFormat: 'auto',
    decimalSeparator: 'auto',
    amountMode: 'signed',
    invertSign: false,
    columns: { date: '', description: [''] },
    typeValues: {
      debit: ['D', 'DEBITO', 'SAIDA', 'PAGAR', 'PAGAMENTO', 'DESPESA', '-'],
      credit: ['C', 'CREDITO', 'ENTRADA', 'RECEBER', 'RECEBIMENTO', 'RECEITA', '+'],
    },
    skipRowPatterns: [...DEFAULT_SKIP_ROW_PATTERNS],
  };
}

/** Erros por campo (chave = caminho, ex.: `columns.amount`); vazio quando a configuração é válida. */
export type MappingErrors = Record<string, string>;

const POSITION = /^#[1-9][0-9]*$/;

export function validateImportMapping(v: ImportMappingValue): MappingErrors {
  const e: MappingErrors = {};
  const c = v.columns;
  const noHeader = v.headerRow === 0;
  const ref = (key: string, value: string | undefined, required: boolean) => {
    const text = (value ?? '').trim();
    if (!text) {
      if (required) e[key] = 'Informe a coluna.';
      return;
    }
    if (text.length > 120) e[key] = 'Use no máximo 120 caracteres.';
    else if (noHeader && !POSITION.test(text)) e[key] = 'Sem linha de cabeçalho, use a posição da coluna, como #1, #2.';
  };
  const headerErr = rangeError(v.headerRow, 0, 200);
  if (headerErr) e.headerRow = headerErr;
  if ((v.sheetName ?? '').length > 100) e.sheetName = 'Use no máximo 100 caracteres.';

  ref('columns.date', c.date, true);
  const descriptions = c.description.map((d) => d.trim()).filter(Boolean);
  if (descriptions.length === 0) e['columns.description'] = 'Informe ao menos uma coluna de descrição.';
  c.description.forEach((d, i) => ref(`columns.description.${i}`, d, false));
  if (v.amountMode === 'signed') ref('columns.amount', c.amount, true);
  if (v.amountMode === 'debit_credit') {
    ref('columns.debit', c.debit, true);
    ref('columns.credit', c.credit, true);
    if (c.debit?.trim() && c.debit.trim() === c.credit?.trim()) e['columns.credit'] = 'Débito e crédito devem ser colunas diferentes.';
  }
  if (v.amountMode === 'type_column') {
    ref('columns.amount', c.amount, true);
    ref('columns.typeColumn', c.typeColumn, true);
    if (v.typeValues.debit.length === 0) e['typeValues.debit'] = 'Informe ao menos um valor que indica saída.';
    if (v.typeValues.credit.length === 0) e['typeValues.credit'] = 'Informe ao menos um valor que indica entrada.';
    const overlap = v.typeValues.debit.filter((x) => v.typeValues.credit.some((y) => y.toUpperCase() === x.toUpperCase()));
    if (overlap.length > 0) e['typeValues.credit'] = `"${overlap[0]}" está nos dois grupos.`;
  }
  for (const key of ['externalId', 'document', 'reference', 'counterparty', 'dueDate', 'bankAccountRef', 'costCenter', 'category'] as const) {
    ref(`columns.${key}`, c[key], false);
  }
  if (v.typeValues.debit.concat(v.typeValues.credit).some((x) => x.length > 40)) e['typeValues.debit'] ??= 'Cada valor tem no máximo 40 caracteres.';
  if (v.skipRowPatterns.length > 30) e.skipRowPatterns = 'No máximo 30 textos.';
  else if (v.skipRowPatterns.some((x) => x.length > 80)) e.skipRowPatterns = 'Cada texto tem no máximo 80 caracteres.';
  return e;
}

/** Remove colunas vazias e as que o modo de valor não usa, pronto para enviar à API. */
export function cleanImportMapping(v: ImportMappingValue): ImportMappingValue {
  const c = v.columns;
  const pick = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);
  const columns: Columns = {
    date: c.date.trim(),
    description: c.description.map((d) => d.trim()).filter(Boolean),
    amount: v.amountMode === 'debit_credit' ? undefined : pick(c.amount),
    debit: v.amountMode === 'debit_credit' ? pick(c.debit) : undefined,
    credit: v.amountMode === 'debit_credit' ? pick(c.credit) : undefined,
    typeColumn: v.amountMode === 'type_column' ? pick(c.typeColumn) : undefined,
    externalId: pick(c.externalId),
    document: pick(c.document),
    reference: pick(c.reference),
    counterparty: pick(c.counterparty),
    dueDate: pick(c.dueDate),
    bankAccountRef: pick(c.bankAccountRef),
    costCenter: pick(c.costCenter),
    category: pick(c.category),
  };
  return { ...v, sheetName: v.sheetName?.trim() ? v.sheetName.trim() : null, columns };
}

/** Texto de lista (uma entrada por separador) com estado local para não perder vírgulas ao digitar. */
function ListField({ label, hint, error, items, onChange, separator, multiline, disabled }: {
  label: string; hint?: string; error?: string | null; items: string[]; onChange: (items: string[]) => void;
  separator: RegExp; multiline?: boolean; disabled?: boolean;
}) {
  const join = (list: string[]) => list.join(multiline ? '\n' : ', ');
  const parse = (text: string) => text.split(separator).map((s) => s.trim()).filter(Boolean);
  const [text, setText] = useState(() => join(items));
  useEffect(() => {
    if (parse(text).join('\u0000') !== items.join('\u0000')) setText(join(items));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const common = { label, hint, error, disabled, value: text, onChange: (e: { target: { value: string } }) => { setText(e.target.value); onChange(parse(e.target.value)); } };
  return multiline ? <Field {...common} multiline rows={5} /> : <Field {...common} />;
}

export interface ImportMappingEditorProps {
  /** Configuração atual (controlado). */
  value: ImportMappingValue;
  onChange: (next: ImportMappingValue) => void;
  /** Cabeçalhos do arquivo; quando informados, as colunas viram listas de escolha. */
  headers?: string[];
  /** Formato do arquivo: oculta opções que só existem em CSV (delimitador, codificação) ou em planilha (aba). */
  fileFormat?: 'csv' | 'xlsx';
  /** Erros por campo (de `validateImportMapping`); omitidos, o editor valida sozinho. */
  errors?: MappingErrors;
  disabled?: boolean;
}

const sectionStyle = { display: 'grid', gap: 'var(--e4)', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', alignItems: 'start' } as const;

/** Editor de mapeamento de colunas de um perfil de importação. */
export function ImportMappingEditor({ value, onChange, headers, fileFormat, errors, disabled }: ImportMappingEditorProps) {
  const errs = errors ?? validateImportMapping(value);
  const set = (patch: Partial<ImportMappingValue>) => onChange({ ...value, ...patch });
  const setCol = (key: SingleColumn, v: string) => onChange({ ...value, columns: { ...value.columns, [key]: v } });
  const hasHeaders = headers !== undefined && headers.length > 0;
  const noHeader = value.headerRow === 0;

  const colHint = hasHeaders ? undefined : noHeader ? 'Use a posição da coluna: #1, #2, #3…' : 'Nome exato do cabeçalho, ou #3 para a terceira coluna.';

  const columnPicker = (field: SingleColumn, label: string, required?: boolean, hint?: string) => {
    const current = (value.columns[field] as string | undefined) ?? '';
    const error = errs[`columns.${field}`] ?? null;
    if (hasHeaders) {
      const known = headers.includes(current) || current === '';
      return (
        <Select label={label + (required ? ' *' : '')} hint={hint} error={error} disabled={disabled} value={current}
          placeholder={required ? 'Escolha a coluna' : 'Não usar'}
          onChange={(e) => setCol(field, e.target.value)}
          options={[...(known ? [] : [{ value: current, label: `${current} (não está no arquivo)` }]), ...headers.map((h) => ({ value: h, label: h }))]} />
      );
    }
    return <Field label={label + (required ? ' *' : '')} hint={hint ?? colHint} error={error} disabled={disabled} value={current} onChange={(e) => setCol(field, e.target.value)} />;
  };

  const descriptions = value.columns.description;
  const setDescriptions = (list: string[]) => onChange({ ...value, columns: { ...value.columns, description: list } });

  return (
    <div className="pilha" style={{ gap: 'var(--e5)' }}>
      <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={disabled}>
        <legend style={{ fontWeight: 600, marginBottom: 'var(--e3)' }}>Leitura do arquivo</legend>
        <div style={sectionStyle}>
          {fileFormat !== 'xlsx' && (
            <Select label="Delimitador" value={value.delimiter} onChange={(e) => set({ delimiter: e.target.value as ImportMappingValue['delimiter'] })}
              hint="Caractere que separa as colunas no CSV. Automático costuma funcionar."
              options={[{ value: 'auto', label: 'Automático' }, { value: ';', label: 'Ponto e vírgula (;)' }, { value: ',', label: 'Vírgula (,)' }, { value: 'tab', label: 'Tabulação' }, { value: '|', label: 'Barra vertical (|)' }]} />
          )}
          {fileFormat !== 'xlsx' && (
            <Select label="Codificação" value={value.encoding} onChange={(e) => set({ encoding: e.target.value as ImportMappingValue['encoding'] })}
              hint="Se acentos aparecerem trocados, escolha Windows-1252."
              options={[{ value: 'auto', label: 'Automática' }, { value: 'utf-8', label: 'UTF-8' }, { value: 'windows-1252', label: 'Windows-1252' }]} />
          )}
          {fileFormat !== 'csv' && (
            <Field label="Aba da planilha" hint="Deixe vazio para usar a primeira aba." value={value.sheetName ?? ''} error={errs.sheetName}
              onChange={(e) => set({ sheetName: e.target.value })} />
          )}
          <NumberField label="Linha do cabeçalho" value={value.headerRow} onChange={(v) => set({ headerRow: v })} error={errs.headerRow}
            hint="Linha onde estão os nomes das colunas. 0 = arquivo sem cabeçalho (use #1, #2… nas colunas)." />
          <Select label="Formato de data" value={value.dateFormat} onChange={(e) => set({ dateFormat: e.target.value as ImportMappingValue['dateFormat'] })}
            hint="Como as datas aparecem no arquivo. Em Automático, datas como 03/04 podem ser ambíguas; prefira indicar."
            options={[{ value: 'auto', label: 'Automático' }, { value: 'DD/MM/YYYY', label: 'DD/MM/AAAA' }, { value: 'MM/DD/YYYY', label: 'MM/DD/AAAA' }, { value: 'YYYY-MM-DD', label: 'AAAA-MM-DD' }, { value: 'YYYYMMDD', label: 'AAAAMMDD' }]} />
          <Select label="Separador decimal" value={value.decimalSeparator} onChange={(e) => set({ decimalSeparator: e.target.value as ImportMappingValue['decimalSeparator'] })}
            hint="Como os valores são escritos: 1.234,56 usa vírgula; 1,234.56 usa ponto."
            options={[{ value: 'auto', label: 'Automático' }, { value: ',', label: 'Vírgula (1.234,56)' }, { value: '.', label: 'Ponto (1,234.56)' }]} />
        </div>
      </fieldset>

      <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={disabled}>
        <legend style={{ fontWeight: 600, marginBottom: 'var(--e3)' }}>Valor</legend>
        <div style={sectionStyle}>
          <Select label="Como o valor aparece" value={value.amountMode} onChange={(e) => set({ amountMode: e.target.value as ImportMappingValue['amountMode'] })}
            hint="Com sinal: uma coluna, saídas negativas. Débito e crédito: duas colunas. Valor + tipo: valor sem sinal e uma coluna dizendo se é entrada ou saída."
            options={[{ value: 'signed', label: 'Uma coluna, com sinal' }, { value: 'debit_credit', label: 'Colunas de débito e crédito' }, { value: 'type_column', label: 'Valor e coluna de tipo' }]} />
          <div style={{ paddingTop: 'var(--e5)' }}>
            <Checkbox label="Inverter o sinal" checked={value.invertSign} onChange={(e) => set({ invertSign: e.target.checked })}
              hint="Use quando o arquivo mostra as saídas como positivas (ex.: fatura de cartão)." />
          </div>
        </div>
      </fieldset>

      <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={disabled}>
        <legend style={{ fontWeight: 600, marginBottom: 'var(--e3)' }}>Colunas</legend>
        <div style={sectionStyle}>
          {columnPicker('date', 'Data', true)}
          {value.amountMode === 'debit_credit' ? (
            <>
              {columnPicker('debit', 'Débito (saída)', true)}
              {columnPicker('credit', 'Crédito (entrada)', true)}
            </>
          ) : (
            columnPicker('amount', 'Valor', true)
          )}
          {value.amountMode === 'type_column' && columnPicker('typeColumn', 'Tipo (entrada/saída)', true)}
        </div>

        <div style={{ marginTop: 'var(--e4)' }}>
          <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={disabled}>
            <legend className="campo-rotulo">Descrição * (até 5 colunas, unidas em um só texto)</legend>
            {errs['columns.description'] && <p className="campo-erro" role="alert">{errs['columns.description']}</p>}
            <div className="pilha" style={{ gap: 'var(--e2)' }}>
                {descriptions.map((d, i) => (
                  <div key={i} className="linha" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                    <div style={{ flex: 1 }}>
                      {hasHeaders ? (
                        <Select label={`Coluna ${i + 1}`} value={d} placeholder="Escolha a coluna" disabled={disabled} error={errs[`columns.description.${i}`]}
                          onChange={(e) => setDescriptions(descriptions.map((x, j) => (j === i ? e.target.value : x)))}
                          options={[...(d && !headers.includes(d) ? [{ value: d, label: `${d} (não está no arquivo)` }] : []), ...headers.map((h) => ({ value: h, label: h }))]} />
                      ) : (
                        <Field label={`Coluna ${i + 1}`} hint={i === 0 ? colHint : undefined} value={d} disabled={disabled} error={errs[`columns.description.${i}`]}
                          onChange={(e) => setDescriptions(descriptions.map((x, j) => (j === i ? e.target.value : x)))} />
                      )}
                    </div>
                    {descriptions.length > 1 && (
                      <Button size="sm" variant="ghost" disabled={disabled} style={{ marginTop: 'var(--e6)' }} onClick={() => setDescriptions(descriptions.filter((_, j) => j !== i))}>
                        Remover<span className="sr-only"> coluna {i + 1}</span>
                      </Button>
                    )}
                  </div>
                ))}
                {descriptions.length < 5 && <div><Button size="sm" disabled={disabled} onClick={() => setDescriptions([...descriptions, ''])}>Adicionar coluna de descrição</Button></div>}
            </div>
          </fieldset>
        </div>

        <p className="texto-suave" style={{ margin: 'var(--e5) 0 var(--e3)' }}>Opcionais: preencha o que o arquivo tiver.</p>
        <div style={sectionStyle}>
          {columnPicker('externalId', 'Identificador', false, 'ID da transação ou número de autenticação; é o que mais ajuda a conciliar sem dúvida.')}
          {columnPicker('document', 'Documento', false)}
          {columnPicker('reference', 'Referência', false)}
          {columnPicker('counterparty', 'Favorecido', false)}
          {columnPicker('dueDate', 'Vencimento', false)}
          {columnPicker('bankAccountRef', 'Conta', false)}
          {columnPicker('costCenter', 'Centro de custo', false)}
          {columnPicker('category', 'Categoria', false)}
        </div>
      </fieldset>

      {value.amountMode === 'type_column' && (
        <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={disabled}>
          <legend style={{ fontWeight: 600, marginBottom: 'var(--e3)' }}>Valores da coluna de tipo</legend>
          <div style={sectionStyle}>
            <ListField label="Indicam saída" hint="Separe por vírgula. Ex.: D, DEBITO, SAIDA" items={value.typeValues.debit} separator={/[,;\n]/}
              error={errs['typeValues.debit']} onChange={(debit) => set({ typeValues: { ...value.typeValues, debit } })} />
            <ListField label="Indicam entrada" hint="Separe por vírgula. Ex.: C, CREDITO, ENTRADA" items={value.typeValues.credit} separator={/[,;\n]/}
              error={errs['typeValues.credit']} onChange={(credit) => set({ typeValues: { ...value.typeValues, credit } })} />
          </div>
        </fieldset>
      )}

      <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={disabled}>
        <legend style={{ fontWeight: 600, marginBottom: 'var(--e3)' }}>Linhas a ignorar</legend>
        <ListField label="Textos de linhas a ignorar" multiline items={value.skipRowPatterns} separator={/\n/} error={errs.skipRowPatterns}
          hint="Um por linha. Linhas cuja descrição começa com um destes textos (ex.: SALDO ANTERIOR) não viram transações."
          onChange={(skipRowPatterns) => set({ skipRowPatterns })} />
      </fieldset>
    </div>
  );
}
