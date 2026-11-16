import { parseAmount } from '@concilia/core/shared';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type Page } from '../../api/client';
import { Badge } from '../../components/Badge';
import { DateText } from '../../components/DateText';
import { Money } from '../../components/Money';
import type { Filters, Match, MatchItem, Side } from './tipos';

export const SIDE_LABEL: Record<Side, string> = { bank: 'Extrato', ledger: 'Lançamentos' };

export interface Option { id: string; name: string; active?: boolean }

export function useOptions(path: string) {
  return useQuery({
    queryKey: [path, 'options'],
    staleTime: 60_000,
    queryFn: () => api.get<Page<Option>>(path, { limit: 200 }),
  });
}

/** Valor digitado em reais para centavos; vazio ou inválido vira undefined. */
export function centsOf(text: string): number | undefined {
  if (!text.trim()) return undefined;
  try {
    return Math.abs(parseAmount(text));
  } catch {
    return undefined;
  }
}

export function amountInvalid(text: string): boolean {
  return text.trim() !== '' && centsOf(text) === undefined;
}

/** Parâmetros de consulta de itens a partir dos filtros. */
export function itemQuery(f: Filters) {
  return {
    bankAccountId: f.bankAccountId, dateFrom: f.dateFrom, dateTo: f.dateTo, q: f.q.trim(), kind: f.kind,
    direction: f.direction, amountMin: centsOf(f.amountMin), amountMax: centsOf(f.amountMax),
  };
}

/** Filtros aplicados no navegador às sugestões (a API só filtra por conta). */
export function matchPasses(m: Match, f: Filters): boolean {
  const items: MatchItem[] = [...m.bank, ...m.ledger];
  const min = centsOf(f.amountMin);
  const max = centsOf(f.amountMax);
  const q = f.q.trim().toLowerCase();
  return items.some((i) => {
    if (f.dateFrom && i.date < f.dateFrom) return false;
    if (f.dateTo && i.date > f.dateTo) return false;
    if (f.kind && i.kind !== f.kind) return false;
    if (f.direction === 'credit' && i.amountCents <= 0) return false;
    if (f.direction === 'debit' && i.amountCents >= 0) return false;
    if (min !== undefined && Math.abs(i.amountCents) < min) return false;
    if (max !== undefined && Math.abs(i.amountCents) > max) return false;
    if (q && ![i.description, i.document, i.reference, i.externalId].some((v) => v?.toLowerCase().includes(q))) return false;
    return true;
  });
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && e.code === 'already_reconciled';
}

/** Selos de divergência/ambiguidade de uma sugestão. */
export function MatchFlags({ match }: { match: Match }) {
  const diffs: string[] = [];
  if (match.differenceCents !== 0) diffs.push(`valor ${match.differenceCents > 0 ? '+' : '−'}${formatAbs(match.differenceCents)}`);
  if (match.dateDiffDays !== 0) diffs.push(plural(Math.abs(match.dateDiffDays), 'dia', 'dias'));
  return (
    <span className="linha conc-selos">
      {match.ambiguous && <Badge tone="info">Ambígua</Badge>}
      {match.divergence === 'duplicate' && <Badge tone="danger">Divergência: possível duplicidade</Badge>}
      {match.divergence && match.divergence !== 'duplicate' && (
        <Badge tone="danger">Divergência{diffs.length ? `: ${diffs.join(' e ')} de diferença` : ''}</Badge>
      )}
      {!match.divergence && diffs.length > 0 && <Badge tone="warning">Diferença: {diffs.join(' e ')}</Badge>}
    </span>
  );
}

function formatAbs(cents: number): string {
  return (Math.abs(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Cartão compacto de um lado (data, valor, descrição, documento). */
export function SideCard({ title, items }: { title: string; items: MatchItem[] }) {
  return (
    <div className="conc-lado">
      <h4>{title}</h4>
      {items.length === 0 && <p className="texto-suave">Nenhum item.</p>}
      {items.map((i) => (
        <div key={i.id} className="conc-item">
          <div className="conc-item-topo">
            <DateText value={i.date} />
            <Money cents={i.amountCents} />
          </div>
          <div className="conc-desc">{i.description}</div>
          {(i.document || i.reference || i.externalId) && (
            <div className="texto-suave conc-peq">{[i.document, i.reference, i.externalId].filter(Boolean).join(' · ')}</div>
          )}
        </div>
      ))}
    </div>
  );
}

