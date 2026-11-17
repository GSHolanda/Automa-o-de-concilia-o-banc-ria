import type { ReactNode } from 'react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Spinner } from './Spinner';

export interface Column<T> {
  key: string;
  header: string;
  /** Conteúdo da célula; padrão: row[key]. */
  render?: (row: T) => ReactNode;
  /** Valores numéricos/monetários: à direita, algarismos tabulares. */
  align?: 'left' | 'right' | 'center';
  width?: string;
  /** Mostra botão de ordenação no cabeçalho. */
  sortable?: boolean;
  /** Oculta em telas estreitas (< 640 px). */
  hideOnMobile?: boolean;
}

export interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  /** Descrição acessível da tabela. */
  caption: string;
  loading?: boolean;
  /** Erro de carregamento; mostra mensagem e botão "Tentar novamente" se onRetry existir. */
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  /** Torna a linha clicável (e acessível por teclado). */
  onRowClick?: (row: T) => void;
  /** Seleção múltipla: chaves selecionadas e callback. */
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /** Rodapé (ex.: <Pagination />). */
  footer?: ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  loading = false,
  error,
  onRetry,
  emptyTitle = 'Nenhum registro encontrado',
  emptyDescription,
  emptyAction,
  onRowClick,
  selectedKeys,
  onSelectionChange,
  sort,
  onSortChange,
  footer,
}: DataTableProps<T>) {
  if (error) {
    return (
      <EmptyState
        tone="error"
        title="Não foi possível carregar os dados"
        description={error}
        action={onRetry && <Button onClick={onRetry}>Tentar novamente</Button>}
      />
    );
  }
  if (loading && !rows) {
    return (
      <div className="vazio">
        <Spinner />
      </div>
    );
  }
  if (!rows || rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />;
  }

  const selectable = Boolean(selectedKeys && onSelectionChange);
  const allKeys = rows.map(rowKey);
  const allSelected = selectable && allKeys.every((k) => selectedKeys?.has(k));
  const someSelected = selectable && !allSelected && allKeys.some((k) => selectedKeys?.has(k));

  function toggleAll() {
    if (!onSelectionChange) return;
    const next = new Set(selectedKeys);
    for (const k of allKeys) {
      if (allSelected) next.delete(k);
      else next.add(k);
    }
    onSelectionChange(next);
  }
  function toggleOne(k: string) {
    if (!onSelectionChange) return;
    const next = new Set(selectedKeys);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onSelectionChange(next);
  }

  return (
    <div className="tabela-bloco" aria-busy={loading || undefined}>
      <div className="tabela-rolagem">
        <table className="tabela">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {selectable && (
                <th scope="col" className="col-selecao">
                  <input
                    type="checkbox"
                    aria-label="Selecionar todas as linhas"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                  />
                </th>
              )}
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    style={c.width ? { width: c.width } : undefined}
                    className={`${c.align === 'right' ? 'num' : c.align === 'center' ? 'centro' : ''} ${c.hideOnMobile ? 'so-desktop' : ''}`.trim()}
                    aria-sort={active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {c.sortable && onSortChange ? (
                      <button
                        type="button"
                        className="th-ordenar"
                        onClick={() => onSortChange({ key: c.key, direction: active && sort?.direction === 'asc' ? 'desc' : 'asc' })}
                      >
                        {c.header}
                        <span aria-hidden="true">{active ? (sort?.direction === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const k = rowKey(row);
              const selected = selectedKeys?.has(k) ?? false;
              return (
                <tr
                  key={k}
                  className={`${onRowClick ? 'linha-clicavel' : ''} ${selected ? 'linha-selecionada' : ''}`.trim()}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {selectable && (
                    <td className="col-selecao" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label="Selecionar linha" checked={selected} onChange={() => toggleOne(k)} />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`${c.align === 'right' ? 'num' : c.align === 'center' ? 'centro' : ''} ${c.hideOnMobile ? 'so-desktop' : ''}`.trim()}
                    >
                      {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer && <div className="tabela-rodape">{footer}</div>}
    </div>
  );
}
