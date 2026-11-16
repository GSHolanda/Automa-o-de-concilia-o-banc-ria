import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, type Page } from '../../api/client';
import { useAuth } from '../../auth';
import { Button } from '../../components/Button';
import { DataTable, type Column } from '../../components/DataTable';
import { DateText } from '../../components/DateText';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { Money } from '../../components/Money';
import { PageHeader } from '../../components/PageHeader';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/Spinner';
import { StatusBadge } from '../../components/StatusBadge';
import './painel.css';

type StatusKey = 'reconciled' | 'pending' | 'divergent' | 'ignored' | 'awaitingApproval';
const STATUS_ORDER: StatusKey[] = ['reconciled', 'pending', 'divergent', 'ignored', 'awaitingApproval'];
const STATUS_LABEL: Record<StatusKey, string> = {
  reconciled: 'Conciliados',
  pending: 'Pendentes',
  divergent: 'Divergentes',
  ignored: 'Ignorados',
  awaitingApproval: 'Aguardando aprovação',
};
/** Aba de /conciliacao para cada situação (aguardando aprovação não tem aba: usa `situacao`). */
const TAB: Record<StatusKey, string> = {
  reconciled: 'conciliados',
  pending: 'pendentes',
  divergent: 'divergentes',
  ignored: 'ignorados',
  awaitingApproval: 'pendentes',
};
const SIDE_PARAM = { bank: 'extrato', ledger: 'lancamentos' } as const;

interface Totals { count: number; amountCents: number }
type Summary = Record<StatusKey | 'total', Totals>;
interface Dashboard {
  bank: Summary;
  ledger: Summary;
  openSuggestions: number;
  pendingApprovals: number;
  byAccount: { bankAccountId: string; name: string; active: boolean; bank: Summary; ledger: Summary }[];
  lastImport: { id: string; fileName: string; status: string; createdAt: string; processedAt: string | null } | null;
  lastRun: { id: string; periodStart: string; periodEnd: string; status: string; createdAt: string; finishedAt: string | null } | null;
  autoReconciliation: { reconciled: number; auto: number; rate: number | null };
}
interface Account { id: string; name: string }

function monthRange(): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const last = new Date(y, m, 0).getDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

interface Scope { account: string; from: string; to: string }

/** Parâmetros lidos por /conciliacao: aba, lado, situacao (só aguardando aprovação), conta, de, ate. */
function conciliationLink(status: StatusKey, side: 'bank' | 'ledger', scope: Scope, accountId?: string): string {
  const p = new URLSearchParams({ aba: TAB[status], lado: SIDE_PARAM[side] });
  if (status === 'awaitingApproval') p.set('situacao', 'awaiting_approval');
  const account = accountId ?? scope.account;
  if (account) p.set('conta', account);
  if (scope.from) p.set('de', scope.from);
  if (scope.to) p.set('ate', scope.to);
  return `/conciliacao?${p.toString()}`;
}

function StackedBar({ summary, title }: { summary: Summary; title: string }) {
  const total = summary.total.count;
  return (
    <div>
      <div
        className="painel-barra"
        role="img"
        aria-label={`${title}: ${STATUS_ORDER.map((s) => `${STATUS_LABEL[s]} ${summary[s].count}`).join(', ')}`}
      >
        {total > 0 &&
          STATUS_ORDER.filter((s) => summary[s].count > 0).map((s) => (
            <span key={s} className={`bg-${s}`} style={{ width: `${(summary[s].count / total) * 100}%` }} />
          ))}
      </div>
      <ul className="painel-legenda">
        {STATUS_ORDER.map((s) => (
          <li key={s}>
            <i className={`bg-${s}`} aria-hidden="true" />
            {STATUS_LABEL[s]}: {summary[s].count}
            {total > 0 ? ` (${Math.round((summary[s].count / total) * 100)}%)` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SidePanel({ title, side, summary, scope }: { title: string; side: 'bank' | 'ledger'; summary: Summary; scope: Scope }) {
  return (
    <section className="cartao pilha" aria-label={title}>
      <h2>{title}</h2>
      <div className="painel-grade">
        {STATUS_ORDER.map((s) => (
          <Link key={s} to={conciliationLink(s, side, scope)} className={`painel-quadro st-${s}`}>
            <div className="rotulo">{STATUS_LABEL[s]}</div>
            <div className="qtd">{summary[s].count}</div>
            <Money cents={summary[s].amountCents} />
          </Link>
        ))}
      </div>
      <StackedBar summary={summary} title={title} />
    </section>
  );
}

export function PainelPage() {
  const { can, hasModule } = useAuth();
  const initial = monthRange();
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const periodInvalid = from !== '' && to !== '' && from > to;
  const scope: Scope = { account, from, to };

  const accounts = useQuery({ queryKey: ['bank-accounts', 'select'], queryFn: () => api.get<Page<Account>>('/bank-accounts') });
  const dash = useQuery({
    queryKey: ['dashboard', account, from, to],
    enabled: !periodInvalid,
    queryFn: () => api.get<Dashboard>('/dashboard', { bankAccountId: account || undefined, dateFrom: from || undefined, dateTo: to || undefined }),
  });

  const data = dash.data;
  const empty = data && data.bank.total.count === 0 && data.ledger.total.count === 0 && !data.lastImport && !data.lastRun;
  const canApprove = can('reconciliation.approve') && hasModule('approvals');

  const columns: Column<Dashboard['byAccount'][number]>[] = [
    { key: 'name', header: 'Conta', render: (r) => (r.active ? r.name : `${r.name} (inativa)`) },
    ...(['bank', 'ledger'] as const).flatMap((side) =>
      STATUS_ORDER.map((s) => ({
        key: `${side}-${s}`,
        header: `${side === 'bank' ? 'Extrato' : 'Lanç.'} ${STATUS_LABEL[s].toLowerCase()}`,
        align: 'right' as const,
        hideOnMobile: s !== 'pending' && s !== 'divergent',
        render: (r: Dashboard['byAccount'][number]) => (
          <Link to={conciliationLink(s, side, scope, r.bankAccountId)}>
            {r[side][s].count} · <Money cents={r[side][s].amountCents} />
          </Link>
        ),
      })),
    ),
  ];

  return (
    <div className="pilha">
      <PageHeader title="Painel" subtitle="Situação da conciliação no período." />
      <form className="painel-filtros" onSubmit={(e) => e.preventDefault()} aria-label="Filtros do painel">
        <Select
          label="Conta bancária"
          placeholder="Todas as contas"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          options={(accounts.data?.items ?? []).map((a) => ({ value: a.id, label: a.name }))}
        />
        <Field label="De" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field
          label="Até"
          type="date"
          value={to}
          error={periodInvalid ? 'A data inicial deve ser anterior ou igual à final.' : null}
          onChange={(e) => setTo(e.target.value)}
        />
      </form>

      {dash.isLoading && !periodInvalid && (
        <div role="status" className="linha"><Spinner /> Carregando painel…</div>
      )}
      {dash.isError && (
        <EmptyState tone="error" title="Não foi possível carregar o painel" description={errorMessage(dash.error)} action={<Button onClick={() => void dash.refetch()}>Tentar de novo</Button>} />
      )}

      {data && empty && (
        <EmptyState
          title="Comece importando seus arquivos"
          description="1. Importe o extrato e os lançamentos. 2. Execute a conciliação. Depois, acompanhe os resultados aqui."
          action={
            <div className="linha">
              {can('imports.create') && <Link to="/importacoes/nova" className="btn btn-primary">Importar arquivos</Link>}
              {can('reconciliation.view') && <Link to="/conciliacao" className="btn btn-secondary">Executar conciliação</Link>}
            </div>
          }
        />
      )}

      {data && !empty && (
        <>
          <div className="painel-lados">
            <SidePanel title="Extrato bancário" side="bank" summary={data.bank} scope={scope} />
            <SidePanel title="Lançamentos" side="ledger" summary={data.ledger} scope={scope} />
          </div>

          <section aria-label="Indicadores" className="painel-ind">
            <div className="cartao">
              <div className="texto-suave">Sugestões aguardando revisão</div>
              <div className="qtd">{data.openSuggestions}</div>
              <Link to="/conciliacao?aba=sugestoes">Revisar sugestões</Link>
            </div>
            <div className="cartao">
              <div className="texto-suave">Aprovações pendentes</div>
              <div className="qtd">{data.pendingApprovals}</div>
              {canApprove ? <Link to="/aprovacoes">Ver aprovações</Link> : <span className="texto-suave">Sem permissão para aprovar</span>}
            </div>
            <div className="cartao">
              <div className="texto-suave">Conciliação automática</div>
              <div className="qtd">
                {data.autoReconciliation.rate === null ? '—' : `${(data.autoReconciliation.rate * 100).toFixed(1).replace('.', ',')}%`}
              </div>
              <span className="texto-suave">{data.autoReconciliation.auto} de {data.autoReconciliation.reconciled} conciliados</span>
            </div>
          </section>

          <section className="painel-lados" aria-label="Últimas atividades">
            <div className="cartao pilha">
              <h2>Última importação</h2>
              {data.lastImport ? (
                <div>
                  <StatusBadge status={data.lastImport.status} /> <Link to={`/importacoes/${data.lastImport.id}`}>{data.lastImport.fileName}</Link>
                  <div className="texto-suave"><DateText value={data.lastImport.processedAt ?? data.lastImport.createdAt} withTime /></div>
                </div>
              ) : (
                <p className="texto-suave">Nenhuma importação ainda. <Link to="/importacoes/nova">Importar</Link></p>
              )}
            </div>
            <div className="cartao pilha">
              <h2>Última execução</h2>
              {data.lastRun ? (
                <div>
                  <StatusBadge status={data.lastRun.status} />{' '}
                  <Link to="/conciliacao">
                    <DateText value={data.lastRun.periodStart} /> a <DateText value={data.lastRun.periodEnd} />
                  </Link>
                  <div className="texto-suave"><DateText value={data.lastRun.finishedAt ?? data.lastRun.createdAt} withTime /></div>
                </div>
              ) : (
                <p className="texto-suave">Nenhuma execução ainda. <Link to="/conciliacao">Executar conciliação</Link></p>
              )}
            </div>
          </section>

          <section className="cartao pilha" aria-label="Por conta bancária">
            <h2>Por conta bancária</h2>
            <DataTable
              caption="Situações por conta bancária"
              columns={columns}
              rows={data.byAccount}
              rowKey={(r) => r.bankAccountId}
              emptyTitle="Nenhuma conta bancária cadastrada"
            />
            <p className="texto-suave">Cada célula mostra quantidade e valor e abre a conciliação filtrada.</p>
          </section>
        </>
      )}
    </div>
  );
}
