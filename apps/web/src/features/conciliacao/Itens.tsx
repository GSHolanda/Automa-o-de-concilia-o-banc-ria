import { ITEM_KIND_LABELS } from '@concilia/core/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage, type Page } from '../../api/client';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { DataTable, type Column } from '../../components/DataTable';
import { DateText } from '../../components/DateText';
import { Field } from '../../components/Field';
import { Money } from '../../components/Money';
import { Pagination } from '../../components/Pagination';
import { StatusBadge } from '../../components/StatusBadge';
import { useWrite } from '../shared';
import { doneMessage, useConflict, type Acoes } from './acoes';
import { itemQuery, plural, SIDE_LABEL } from './comum';
import { RECON_KEY, type Filters, type ItemStatus, type ReconItem, type Side } from './tipos';

const PAGE_SIZE = 50;

interface Common {
  status: ItemStatus;
  filters: Filters;
  acoes: Acoes;
  canWrite: boolean;
  canUndo: boolean;
  onDetail: (side: Side, id: string) => void;
}

function ItemPanel({ side, status, filters, acoes, canWrite, canUndo, onDetail, selection }: Common & {
  side: Side;
  selection?: { keys: ReadonlySet<string>; onChange: (keys: Set<string>, rows: ReconItem[]) => void };
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const q = useQuery({
    queryKey: [...RECON_KEY, 'items', side, status, filters, cursor],
    queryFn: () => api.get<Page<ReconItem>>('/reconciliation/items', { side, status, ...itemQuery(filters), limit: PAGE_SIZE, cursor }),
    placeholderData: (prev) => prev,
  });
  const rows = q.data?.items;
  const next = q.data?.nextCursor ?? undefined;

  const columns: Column<ReconItem>[] = [
    { key: 'date', header: 'Data', render: (i) => <DateText value={i.date} /> },
    {
      key: 'desc',
      header: 'Descrição',
      render: (i) => (
        <div>
          <div className="conc-desc">{i.description}</div>
          <div className="texto-suave conc-peq">
            {ITEM_KIND_LABELS[i.kind]}{i.document ? ` · ${i.document}` : ''}{i.categoryName ? ` · ${i.categoryName}` : ''}
          </div>
          {i.duplicateSuspect && <Badge tone="warning">Possível duplicidade</Badge>}
          {i.openSuggestions > 0 && <Badge tone="info">{plural(i.openSuggestions, 'sugestão', 'sugestões')}</Badge>}
        </div>
      ),
    },
    { key: 'amount', header: 'Valor', align: 'right', render: (i) => <Money cents={i.amountCents} /> },
    {
      key: 'status',
      header: 'Situação',
      hideOnMobile: true,
      render: (i) => <StatusBadge status={i.status === 'awaiting_approval' ? 'pending_approval' : i.status} />,
    },
    {
      key: 'acoes',
      header: 'Ações',
      render: (i) => (
        <span className="linha conc-acoes" onClick={(e) => e.stopPropagation()}>
          {canWrite && (i.status === 'pending' || i.status === 'divergent') && (
            <>
              <Button size="sm" onClick={() => acoes.ignore(i)}>Ignorar</Button>
              {i.side === 'bank' && <Button size="sm" onClick={() => acoes.classify(i)}>Classificar</Button>}
            </>
          )}
          {canUndo && i.activeMatch && (i.status === 'reconciled' || i.status === 'ignored') && (
            <Button size="sm" variant="danger" onClick={() => acoes.undo(i.activeMatch!.id, i.description)}>Desfazer</Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <DataTable<ReconItem>
      caption={`Itens de ${SIDE_LABEL[side]}`}
      columns={columns}
      rows={rows}
      rowKey={(i) => i.id}
      loading={q.isFetching}
      error={q.isError ? errorMessage(q.error) : null}
      onRetry={() => void q.refetch()}
      emptyTitle="Nenhum item nesta situação"
      emptyDescription="Ajuste os filtros ou execute a conciliação."
      onRowClick={(i) => onDetail(i.side, i.id)}
      selectedKeys={selection?.keys}
      onSelectionChange={selection && rows ? (keys) => selection.onChange(keys, rows) : undefined}
      footer={
        <Pagination
          hasPrev={cursors.length > 1}
          hasNext={Boolean(next)}
          loading={q.isFetching}
          onPrev={() => setCursors((c) => c.slice(0, -1))}
          onNext={() => next && setCursors((c) => [...c, next])}
          summary={`Página ${cursors.length}`}
        />
      }
    />
  );
}

/** Aba com lista única e alternância Extrato / Lançamentos. */
function SingleList(props: Common & { lado: Side; onLado: (l: Side) => void }) {
  const { lado, onLado, ...rest } = props;
  return (
    <div className="pilha">
      <div className="conc-alterna" role="group" aria-label="Origem dos itens">
        {(['bank', 'ledger'] as Side[]).map((s) => (
          <Button key={s} size="sm" variant={s === lado ? 'primary' : 'secondary'} aria-pressed={s === lado} onClick={() => onLado(s)}>
            {SIDE_LABEL[s]}
          </Button>
        ))}
      </div>
      <ItemPanel key={`${lado}-${rest.status}`} side={lado} {...rest} />
    </div>
  );
}

/** Pendentes/Divergentes: dois painéis com seleção e barra de conciliação manual. */
function Manual(props: Common) {
  const conflict = useConflict();
  const [bank, setBank] = useState<Map<string, ReconItem>>(new Map());
  const [ledger, setLedger] = useState<Map<string, ReconItem>>(new Map());
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);

  const update = (setter: typeof setBank) => (keys: Set<string>, rows: ReconItem[]) =>
    setter((prev) => {
      const map = new Map<string, ReconItem>();
      for (const k of keys) {
        const it = prev.get(k) ?? rows.find((r) => r.id === k);
        if (it) map.set(k, it);
      }
      return map;
    });

  const sum = (m: Map<string, ReconItem>) => [...m.values()].reduce((t, i) => t + i.amountCents, 0);
  const bankSum = sum(bank);
  const ledgerSum = sum(ledger);
  const diff = bankSum - ledgerSum;
  const needsNote = diff !== 0;
  const ready = bank.size > 0 && ledger.size > 0 && bank.size <= 50 && ledger.size <= 50;
  const clear = () => { setBank(new Map()); setLedger(new Map()); setNote(''); setTouched(false); };

  const manual = useWrite<void, { status?: string }>({
    mutationFn: () =>
      api.post('/reconciliation/matches/manual', {
        bankTransactionIds: [...bank.keys()], ledgerEntryIds: [...ledger.keys()], note: note.trim() || undefined,
      }),
    invalidate: [[...RECON_KEY], ['dashboard']],
    inlineError: true,
    success: doneMessage('Conciliação manual registrada.'),
    onSuccess: clear,
  });

  const canWrite = props.canWrite;
  return (
    <div className="pilha">
      <div className="conc-paineis">
        {(['bank', 'ledger'] as Side[]).map((side) => (
          <section key={side} className="pilha">
            <h3>{SIDE_LABEL[side]}</h3>
            <ItemPanel
              {...props}
              side={side}
              selection={canWrite ? { keys: new Set((side === 'bank' ? bank : ledger).keys()), onChange: update(side === 'bank' ? setBank : setLedger) } : undefined}
            />
          </section>
        ))}
      </div>
      {canWrite && (bank.size > 0 || ledger.size > 0) && (
        <div className="conc-barra-fixa" role="region" aria-label="Conciliação manual">
          <div className="conc-somas">
            <span>Extrato ({bank.size}): <Money cents={bankSum} /></span>
            <span>Lançamentos ({ledger.size}): <Money cents={ledgerSum} /></span>
            <strong>Diferença: <Money cents={diff} /></strong>
          </div>
          {needsNote && ready && (
            <Field
              label="Nota (obrigatória com diferença)"
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
              error={touched && !note.trim() ? 'Explique a diferença.' : null}
            />
          )}
          {manual.errorText && <p className="campo-erro" role="alert">{manual.errorText}</p>}
          <div className="linha">
            <Button
              variant="primary"
              disabled={!ready}
              loading={manual.isPending}
              onClick={() => {
                setTouched(true);
                if (needsNote && !note.trim()) return;
                manual.mutate(undefined, { onError: (e) => { if (conflict(e)) clear(); } });
              }}
            >
              Conciliar selecionados
            </Button>
            <Button variant="ghost" onClick={clear}>Limpar seleção</Button>
            {!ready && <span className="texto-suave conc-peq">Selecione ao menos um item de cada lado (até 50).</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function ItensTab(props: Common & { lado: Side; onLado: (l: Side) => void }) {
  const manual = props.status === 'pending' || props.status === 'divergent';
  return manual ? <Manual {...props} /> : <SingleList {...props} />;
}
