import { ITEM_KIND_LABELS } from '@concilia/core/shared';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Button } from '../../components/Button';
import { DateText } from '../../components/DateText';
import { Drawer } from '../../components/Drawer';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { StatusBadge } from '../../components/StatusBadge';
import type { Acoes } from './acoes';
import { MatchFlags, SIDE_LABEL } from './comum';
import { RECON_KEY, MATCH_STATUS_LABEL, type DetailTarget, type ItemDetail, type Match, type ReconItem, type Side } from './tipos';

const BARS: [string, string][] = [
  ['amount', 'Valor'], ['date', 'Data'], ['identifier', 'Identificador'], ['description', 'Descrição'],
];

export function Pct({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="conc-barra" role="img" aria-label={`${pct}%`}>
      <span className="conc-barra-cheia" style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Breakdown({ breakdown }: { breakdown: unknown }) {
  if (!breakdown || typeof breakdown !== 'object') return <p className="texto-suave">Sem decomposição disponível.</p>;
  const b = breakdown as Record<string, unknown>;
  const competitors = typeof b.competitors === 'number' && b.competitors > 0 ? b.competitors : null;
  return (
    <ul className="conc-decomp">
      {BARS.map(([key, label]) =>
        typeof b[key] === 'number' ? (
          <li key={key}>
            <span>{label}</span><Pct value={b[key] as number} /><span className="num">{Math.round((b[key] as number) * 100)}%</span>
          </li>
        ) : null,
      )}
      {competitors !== null && (
        <li>
          <span>Concorrentes</span><Pct value={1 / competitors} /><span className="num">{competitors}</span>
        </li>
      )}
    </ul>
  );
}

function Timeline({ match }: { match: Match }) {
  const rows: { at: string | null; who: string | null; text: string }[] = [
    { at: match.proposedAt ?? match.createdAt, who: match.proposedByName ?? (match.origin === 'engine' ? 'Motor de conciliação' : null), text: match.autoConfirmed ? 'Conciliado automaticamente' : 'Proposta' },
    ...(match.decidedAt ? [{ at: match.decidedAt, who: match.decidedByName, text: `${MATCH_STATUS_LABEL[match.status] ?? match.status}${match.decisionNote ? `: ${match.decisionNote}` : ''}` }] : []),
    ...(match.undoneAt ? [{ at: match.undoneAt, who: match.undoneByName, text: `Desfeita${match.undoReason ? `: ${match.undoReason}` : ''}` }] : []),
  ];
  return (
    <ol className="conc-hist">
      {rows.map((r, i) => (
        <li key={i}>
          <DateText value={r.at} withTime /> · <strong>{r.who ?? 'Sistema'}</strong> — {r.text}
        </li>
      ))}
    </ol>
  );
}

function Dado({ k, children }: { k: string; children: React.ReactNode }) {
  return <div><dt>{k}</dt><dd>{children || '—'}</dd></div>;
}

function ItemBlock({ side, id }: { side: Side; id: string }) {
  const q = useQuery({ queryKey: [...RECON_KEY, 'item', side, id], queryFn: () => api.get<ItemDetail>(`/reconciliation/items/${side}/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <p className="campo-erro">{errorMessage(q.error)}</p>;
  return <ItemData d={q.data} />;
}

function ItemData({ d }: { d: ItemDetail }) {
  const i = d.item;
  return (
    <section className="conc-lado">
      <h4>{SIDE_LABEL[i.side]} <StatusBadge status={i.status} label={i.status === 'awaiting_approval' ? 'Aguardando aprovação' : undefined} /></h4>
      <dl className="conc-dados">
        <Dado k="Data"><DateText value={i.date} /></Dado>
        {i.dueDate && <Dado k="Vencimento"><DateText value={i.dueDate} /></Dado>}
        <Dado k="Valor"><Money cents={i.amountCents} /></Dado>
        <Dado k="Descrição">{i.description}</Dado>
        <Dado k="Tipo">{ITEM_KIND_LABELS[i.kind]}</Dado>
        <Dado k="Documento">{i.document}</Dado>
        <Dado k="Referência">{i.reference}</Dado>
        <Dado k="Id. externo">{i.externalId}</Dado>
        {i.counterparty && <Dado k="Contraparte">{i.counterparty}</Dado>}
        <Dado k="Identificadores">{i.identifiers.join(', ')}</Dado>
        <Dado k="Conta">{i.bankAccountName}</Dado>
        <Dado k="Categoria">{i.categoryName}</Dado>
        <Dado k="Linha na importação">{i.rowNumber}</Dado>
      </dl>
      {i.duplicateSuspect && <p className="campo-erro">Possível duplicidade.</p>}
      <details>
        <summary>Linha bruta</summary>
        <pre className="conc-bruto">{JSON.stringify(d.raw, null, 2)}</pre>
      </details>
    </section>
  );
}

function MatchDetail({ id, acoes, canReview, canUndo }: { id: string; acoes: Acoes; canReview: boolean; canUndo: boolean }) {
  const q = useQuery({ queryKey: [...RECON_KEY, 'match', id], queryFn: () => api.get<Match>(`/reconciliation/matches/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <EmptyState tone="error" title="Não foi possível carregar" description={errorMessage(q.error)} />;
  const m = q.data;
  return (
    <div className="pilha">
      <div className="linha">
        <StatusBadge status={m.status === 'confirmed' ? 'reconciled' : m.status} label={MATCH_STATUS_LABEL[m.status]} />
        <MatchFlags match={m} />
      </div>
      {m.ruleLabel && <p><strong>Regra:</strong> {m.ruleLabel}</p>}
      {m.explanation && <p>{m.explanation}</p>}
      {m.confidence !== null && (
        <div className="linha"><strong>Confiança</strong><Pct value={m.confidence} /><span className="num">{Math.round(m.confidence * 100)}%</span></div>
      )}
      <h3>Decomposição da confiança</h3>
      <Breakdown breakdown={m.breakdown} />
      <div className="conc-lados">
        <div>{m.bank.map((i) => <ItemBlock key={i.id} side="bank" id={i.id} />)}</div>
        <div>{m.ledger.map((i) => <ItemBlock key={i.id} side="ledger" id={i.id} />)}</div>
      </div>
      <h3>Histórico de decisões</h3>
      <Timeline match={m} />
      <div className="linha">
        {m.status === 'suggested' && canReview && (
          <>
            <Button variant="primary" loading={acoes.accepting === m.id} onClick={() => acoes.accept(m.id)}>Aceitar</Button>
            <Button variant="danger" onClick={() => acoes.reject(m.id)}>Rejeitar</Button>
          </>
        )}
        {m.status === 'confirmed' && canUndo && (
          <Button variant="danger" onClick={() => acoes.undo(m.id, 'A conciliação')}>Desfazer</Button>
        )}
      </div>
    </div>
  );
}

function ItemDetailView({ side, id, acoes, canReview, canUndo }: { side: Side; id: string; acoes: Acoes; canReview: boolean; canUndo: boolean }) {
  const q = useQuery({ queryKey: [...RECON_KEY, 'item', side, id], queryFn: () => api.get<ItemDetail>(`/reconciliation/items/${side}/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <EmptyState tone="error" title="Não foi possível carregar" description={errorMessage(q.error)} />;
  const { item: i, history } = q.data;
  const active = i.activeMatch;
  return (
    <div className="pilha">
      <ItemData d={q.data} />
      <div className="linha">
        {canReview && (i.status === 'pending' || i.status === 'divergent') && (
          <>
            <Button onClick={() => acoes.ignore(i as ReconItem)}>Ignorar</Button>
            {i.side === 'bank' && <Button onClick={() => acoes.classify(i as ReconItem)}>Classificar</Button>}
          </>
        )}
        {canUndo && active && (i.status === 'reconciled' || i.status === 'ignored') && (
          <Button variant="danger" onClick={() => acoes.undo(active.id, 'A conciliação')}>Desfazer</Button>
        )}
      </div>
      <h3>Histórico de decisões</h3>
      {history.length === 0 && <p className="texto-suave">Nenhuma decisão registrada.</p>}
      {history.map((m) => (
        <div key={m.id} className="conc-hist-bloco">
          <p className="linha"><strong>{m.ruleLabel ?? (m.origin === 'user' ? 'Decisão manual' : m.type)}</strong> <StatusBadge status={m.status === 'confirmed' ? 'reconciled' : m.status} label={MATCH_STATUS_LABEL[m.status]} /></p>
          {m.confidence !== null && <Breakdown breakdown={m.breakdown} />}
          <Timeline match={m} />
        </div>
      ))}
    </div>
  );
}

export function DetalheDrawer({ target, onClose, acoes }: { target: DetailTarget; onClose: () => void; acoes: Acoes }) {
  const { can, readOnly } = useAuth();
  const canReview = can('reconciliation.review') && !readOnly;
  const canUndo = can('reconciliation.undo') && !readOnly;
  return (
    <Drawer open={target !== null} title={target?.type === 'match' ? 'Detalhe da sugestão' : 'Detalhe do item'} onClose={onClose} width="xl">
      {target?.type === 'match' && <MatchDetail id={target.id} acoes={acoes} canReview={canReview} canUndo={canUndo} />}
      {target?.type === 'item' && <ItemDetailView side={target.side} id={target.id} acoes={acoes} canReview={canReview} canUndo={canUndo} />}
    </Drawer>
  );
}
