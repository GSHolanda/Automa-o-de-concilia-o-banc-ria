import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { Field } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { Select, type SelectOption } from '../../components/Select';
import { FormModal, useWrite } from '../shared';

/** Registro de cadastro: sempre tem `id`; `active` existe quando o cadastro pode ser desativado. */
export interface RegistryRow {
  id: string;
  active?: boolean;
}

export interface OptionsContext<T> {
  rows: T[];
  /** Registro em edição (undefined ao criar). */
  editing?: T;
}

export interface FieldDef<T> {
  /** Nome do campo na API (camelCase). */
  key: string;
  label: string;
  type?: 'text' | 'number' | 'select' | 'checkbox';
  required?: boolean;
  /** Texto/lista vazia vira null no envio (campos opcionais que aceitam null na API). */
  nullable?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  hint?: string;
  placeholder?: string;
  /** Opções de `select`: lista fixa ou calculada a partir da lista carregada. */
  options?: SelectOption[] | ((context: OptionsContext<T>) => SelectOption[]);
  /** Valor inicial ao criar (texto, número como texto ou booleano). */
  defaultValue?: string | number | boolean;
  /** Só enviado na criação (a API aceita, mas o valor não deve mudar depois). */
  createOnly?: boolean;
  /** Mostra o campo só quando a função devolve true (recebe os valores atuais). */
  visibleWhen?: (values: FormValues) => boolean;
}

export type FormValues = Record<string, string | boolean>;

export interface RegistryPageProps<T extends RegistryRow> {
  /** Caminho da API, por exemplo `/categories`. */
  path: string;
  /** Filtros da listagem (`?kind=`), parte da chave de cache. */
  query?: Record<string, string>;
  /** Valores fixos enviados na criação (por exemplo o `kind` da aba). */
  fixed?: Record<string, unknown>;
  /** Título da página (omitido quando `embedded`). */
  title: string;
  subtitle?: string;
  /** Nome singular para botões e mensagens, por exemplo "categoria". */
  noun: string;
  /** "o" ou "a": concordância das mensagens (padrão "a"). */
  gender?: 'o' | 'a';
  /** Colunas de dados; as colunas de situação e de ações são acrescentadas. */
  columns: Column<T>[];
  fields: FieldDef<T>[];
  /** Coluna e controle de ativar/desativar (padrão true). */
  hasActive?: boolean;
  /** Sem cabeçalho de página, para uso dentro de abas. */
  embedded?: boolean;
  /** Conteúdo extra acima da tabela. */
  intro?: ReactNode;
  /** Permissão de escrita; padrão: `settings.manage` e licença não somente leitura. */
  canWrite?: boolean;
  /** Texto da lista vazia. */
  emptyDescription?: string;
}

/** Hook de leitura compartilhado: a mesma chave serve para listas usadas como opções em outros cadastros. */
export function useRegistryList<T>(path: string, query?: Record<string, string>) {
  return useQuery({
    queryKey: ['registry', path, query ?? {}],
    queryFn: () => api.get<{ items: T[] }>(path, query),
  });
}

function initialValues<T extends RegistryRow>(fields: FieldDef<T>[], editing?: T): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    const current = editing ? (editing as unknown as Record<string, unknown>)[f.key] : undefined;
    if (f.type === 'checkbox') {
      values[f.key] = editing ? current === true : f.defaultValue === true;
    } else if (editing) {
      values[f.key] = current === null || current === undefined ? '' : String(current);
    } else {
      values[f.key] = f.defaultValue === undefined ? '' : String(f.defaultValue);
    }
  }
  return values;
}

/** Converte o estado do formulário no corpo da API. */
export function buildPayload<T>(fields: FieldDef<T>[], values: FormValues, creating: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.createOnly && !creating) continue;
    if (f.visibleWhen && !f.visibleWhen(values)) continue;
    const raw = values[f.key];
    if (f.type === 'checkbox') {
      body[f.key] = raw === true;
      continue;
    }
    const text = String(raw ?? '').trim();
    if (text === '') {
      if (f.nullable) body[f.key] = null;
      else if (f.required) body[f.key] = text;
      continue;
    }
    body[f.key] = f.type === 'number' ? Number(text) : text;
  }
  return body;
}

type Dialog = { kind: 'form'; row?: unknown } | { kind: 'delete'; row: unknown } | null;

/** Página de cadastro: lista, criar/editar em modal, ativar/desativar e excluir com confirmação. */
export function RegistryPage<T extends RegistryRow>({
  path, query, fixed, title, subtitle, noun, gender = 'a', columns, fields, hasActive = true, embedded, intro, canWrite, emptyDescription,
}: RegistryPageProps<T>) {
  const { can, readOnly } = useAuth();
  const writable = canWrite ?? (can('settings.manage') && !readOnly);
  const [dialog, setDialog] = useState<Dialog>(null);
  const list = useRegistryList<T>(path, query);
  const rows = list.data?.items;
  const close = () => setDialog(null);
  const invalidate = [['registry', path]];

  const toggle = useWrite({
    mutationFn: (row: T) => api.patch(`${path}/${row.id}`, { active: !row.active }),
    invalidate,
    success: (_r, row) => (row.active ? `${cap(noun)} desativad${gender}.` : `${cap(noun)} ativad${gender}.`),
  });
  const remove = useWrite({
    mutationFn: (row: T) => api.delete(`${path}/${row.id}`),
    invalidate,
    success: `${cap(noun)} excluíd${gender}.`,
    onSuccess: close,
  });

  const all: Column<T>[] = [...columns];
  if (hasActive) {
    all.push({
      key: 'active',
      header: 'Situação',
      render: (r) => <Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Ativo' : 'Inativo'}</Badge>,
    });
  }
  all.push({
    key: 'actions',
    header: 'Ações',
    align: 'right',
    render: (r) => (
      <span className="linha" style={{ justifyContent: 'flex-end', gap: 'var(--e1)' }}>
        <Button size="sm" disabled={!writable} onClick={() => setDialog({ kind: 'form', row: r })}>
          Editar<span className="sr-only"> {noun}</span>
        </Button>
        {hasActive && (
          <Button size="sm" disabled={!writable || toggle.isPending} onClick={() => toggle.mutate(r)}>
            {r.active ? 'Desativar' : 'Ativar'}<span className="sr-only"> {noun}</span>
          </Button>
        )}
        <Button size="sm" variant="danger" disabled={!writable} onClick={() => setDialog({ kind: 'delete', row: r })}>
          Excluir<span className="sr-only"> {noun}</span>
        </Button>
      </span>
    ),
  });

  const newButton = (
    <Button variant="primary" disabled={!writable} onClick={() => setDialog({ kind: 'form' })}>
      {gender === 'a' ? 'Nova' : 'Novo'} {noun}
    </Button>
  );

  return (
    <>
      {embedded ? (
        <div className="linha" style={{ justifyContent: 'flex-end', margin: 'var(--e3) 0' }}>{newButton}</div>
      ) : (
        <PageHeader title={title} subtitle={subtitle} actions={newButton} />
      )}
      {intro}
      <DataTable
        caption={title}
        columns={all}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.isError ? errorMessage(list.error) : null}
        onRetry={() => void list.refetch()}
        emptyTitle={`Nenhum${gender === 'a' ? 'a' : ''} ${noun} cadastrad${gender}`}
        emptyDescription={emptyDescription}
        emptyAction={writable ? newButton : undefined}
      />
      {dialog?.kind === 'form' && (
        <RegistryForm<T>
          path={path}
          noun={noun}
          gender={gender}
          fields={fields}
          fixed={fixed}
          rows={rows ?? []}
          editing={dialog.row as T | undefined}
          invalidate={invalidate}
          onClose={close}
        />
      )}
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title={`Excluir ${noun}`}
        message={`${cap(noun)} será excluíd${gender}. Se estiver em uso, a exclusão será recusada e você poderá apenas desativá-l${gender}. Esta ação não pode ser desfeita.`}
        confirmLabel="Excluir"
        destructive
        onCancel={close}
        onConfirm={async () => {
          if (dialog?.kind === 'delete') await remove.mutateAsync(dialog.row as T).catch(() => undefined);
        }}
      />
    </>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function RegistryForm<T extends RegistryRow>({
  path, noun, gender, fields, fixed, rows, editing, invalidate, onClose,
}: {
  path: string;
  noun: string;
  gender: 'o' | 'a';
  fields: FieldDef<T>[];
  fixed?: Record<string, unknown>;
  rows: T[];
  editing?: T;
  invalidate: string[][];
  onClose: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() => initialValues(fields, editing));
  const set = (key: string, value: string | boolean) => setValues((prev) => ({ ...prev, [key]: value }));

  const save = useWrite({
    inlineError: true,
    invalidate,
    mutationFn: () => {
      const body = buildPayload(fields, values, !editing);
      return editing ? api.patch(`${path}/${editing.id}`, body) : api.post(path, { ...fixed, ...body });
    },
    success: `${cap(noun)} ${editing ? 'atualizad' : 'criad'}${gender}.`,
    onSuccess: onClose,
  });

  return (
    <FormModal
      open
      title={editing ? `Editar ${noun}` : `${gender === 'a' ? 'Nova' : 'Novo'} ${noun}`}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      busy={save.isPending}
      error={save.errorText}
    >
      {fields.map((f) => {
        if (f.visibleWhen && !f.visibleWhen(values)) return null;
        if (f.createOnly && editing) return null;
        const value = values[f.key];
        if (f.type === 'checkbox') {
          return <Checkbox key={f.key} label={f.label} hint={f.hint} checked={value === true} onChange={(e) => set(f.key, e.target.checked)} />;
        }
        if (f.type === 'select') {
          const options = typeof f.options === 'function' ? f.options({ rows, editing }) : (f.options ?? []);
          return (
            <Select
              key={f.key}
              label={f.label}
              hint={f.hint}
              required={f.required}
              options={options}
              placeholder={f.required ? 'Selecione' : (f.placeholder ?? 'Nenhum')}
              value={String(value ?? '')}
              onChange={(e) => set(f.key, e.target.value)}
            />
          );
        }
        return (
          <Field
            key={f.key}
            label={f.label}
            hint={f.hint}
            required={f.required}
            type={f.type === 'number' ? 'number' : 'text'}
            inputMode={f.type === 'number' ? 'numeric' : undefined}
            maxLength={f.maxLength}
            min={f.min}
            max={f.max}
            pattern={f.pattern}
            placeholder={f.placeholder}
            value={String(value ?? '')}
            onChange={(e) => set(f.key, e.target.value)}
          />
        );
      })}
    </FormModal>
  );
}
