import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, errorMessage, type Page } from '../../api/client';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Spinner } from '../../components/Spinner';
import { useWrite } from '../shared';
import { useConflict, type Acoes } from './acoes';
import { matchPasses, MatchFlags, plural, SideCard } from './comum';
import { Pct } from './Detalhe';
import { COUNT_LIMIT, RECON_KEY, type Filters, type Match } from './tipos';

/** Sugestões abertas (até 200), filtradas no navegador pelos filtros da barra. */
export function useSugestoes(filters: Filters) {
  const q = useQuery({
    queryKey: [...RECON_KEY, 'matches', 'suggested', filters.bankAccountId],
    queryFn: () =>
      api.get<Page<Match>>('/reconciliation/matches', { status: 'suggested', bankAccountId: filters.bankAccountId, limit: COUNT_LIMIT }),
  });
  const items = useMemo(() => (q.data?.items ?? []).filter((m) => matchPasses(m, filters)), [q.data, filters]);
  return { query: q, items, capped: Boolean(q.data?.nextCursor) };
}

type BulkResponse = { results: ({ id: string; ok: true; status: string } | { id: string; ok: false; error: { code: string; message: string } })[]; accepted: number; failed: number };

export function SugestoesTab({ data, acoes, canWrite, onDetail }: {
  data: ReturnType<typeof useSugestoes>; acoes: Acoes; canWrite: boolean; onDetail: (id: string) => void;
}) {
  const { query, items, capped } = data;
  const conflict = useConflict();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<BulkResponse | null>(null);
  const eligible = (m: Match) => !m.ambiguous && !m.divergence;
  const byId = new Map(items.map((m) => [m.id, m]));

  const bulk = useWrite<string[], BulkResponse>({
    mutationFn: (ids) => api.post('/reconciliation/matches/bulk-accept', { ids }),
    invalidate: [[...RECON_KEY], ['dashboard']],
    inlineError: true,
    success: (r) => `${plural(r.accepted, 'sugestão aceita', 'sugestões aceitas')}${r.failed ? `, ${r.failed} com falha` : ''}.`,
    onSuccess: (r) => { setResult(r); setSelected(new Set()); },
  });
  const ids = [...selected].filter((id) => byId.has(id));
  const statusOf = (id: string) => (result?.results.find((r) => r.id === id));

  if (query.isLoading) return <div className="vazio"><Spinner /></div>;
  if (query.isError) return <EmptyState tone="error" title="Não foi possível carregar as sugestões" description={errorMessage(query.error)} action={<Button onClick={() => void query.refetch()}>Tentar novamente</Button>} />;

  return (
    <div className="pilha">
      {canWrite && (
        <div className="conc-lote">
          <p className="texto-suave">Sugestões ambíguas e com divergência não entram em lote: revise-as uma a uma.</p>
          <div className="linha">
            <Button
              variant="primary"
              disabled={ids.length === 0}
              loading={bulk.isPending}
              onClick={() => bulk.mutate(ids, { onError: (e) => { conflict(e); } })}
            >
              Aceitar selecionadas{ids.length ? ` (${ids.length})` : ''}
            </Button>
            <Button size="sm" onClick={() => setSelected(new Set(items.filter(eligible).map((m) => m.id)))}>Selecionar elegíveis</Button>
            {ids.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Limpar</Button>}
          </div>
          {bulk.errorText && <p className="campo-erro" role="alert">{bulk.errorText}</p>}
        </div>
      )}
      {result && (
        <div className="conc-resultado" role="status">
          <div className="linha">
            <strong>Resultado do lote: {result.accepted} aceita(s), {result.failed} com falha.</strong>
            <Button size="sm" variant="ghost" onClick={() => setResult(null)}>Dispensar</Button>
          </div>
          <ul>
            {result.results.map((r) => (
              <li key={r.id}>
                {r.ok ? <Badge tone={r.status === 'pending_approval' ? 'info' : 'success'}>{r.status === 'pending_approval' ? 'Aguarda aprovação' : 'Aceita'}</Badge> : <Badge tone="danger">Falhou</Badge>}{' '}
                {byId.get(r.id)?.bank[0]?.description ?? byId.get(r.id)?.ledger[0]?.description ?? r.id}
                {!r.ok && <span className="texto-suave"> — {r.error.message}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {items.length === 0 ? (
        <EmptyState title="Nenhuma sugestão aberta" description="Execute a conciliação ou ajuste os filtros." />
      ) : (
        items.map((m) => (
          <article key={m.id} className="conc-card">
            <header className="conc-card-topo">
              {canWrite && (
                <label className="conc-sel">
                  <input
                    type="checkbox"
                    disabled={!eligible(m)}
                    checked={selected.has(m.id)}
                    onChange={() => setSelected((prev) => { const n = new Set(prev); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}
                  />
                  <span className="sr-only">Selecionar sugestão</span>
                </label>
              )}
              <strong>{m.ruleLabel ?? 'Sugestão'}</strong>
              <MatchFlags match={m} />
              {statusOf(m.id) && <Badge tone={statusOf(m.id)?.ok ? 'success' : 'danger'}>{statusOf(m.id)?.ok ? 'Aceita' : 'Falhou'}</Badge>}
            </header>
            <div className="conc-lados">
              <SideCard title="Extrato" items={m.bank} />
              <SideCard title="Lançamentos" items={m.ledger} />
            </div>
            {m.explanation && <p className="conc-peq">{m.explanation}</p>}
            <div className="linha">
              {m.confidence !== null && <><span>Confiança</span><Pct value={m.confidence} /><strong className="num">{Math.round(m.confidence * 100)}%</strong></>}
            </div>
            <footer className="linha">
              {canWrite && (
                <>
                  <Button variant="primary" size="sm" loading={acoes.accepting === m.id} onClick={() => acoes.accept(m.id)}>Aceitar</Button>
                  <Button variant="danger" size="sm" onClick={() => acoes.reject(m.id)}>Rejeitar</Button>
                </>
              )}
              <Button size="sm" onClick={() => onDetail(m.id)}>Detalhe</Button>
            </footer>
          </article>
        ))
      )}
      {capped && <p className="texto-suave">Exibindo as {COUNT_LIMIT} primeiras sugestões. Trate-as para ver as demais.</p>}
    </div>
  );
}
