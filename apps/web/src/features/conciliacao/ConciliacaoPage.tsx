import { ITEM_KINDS, ITEM_KIND_LABELS } from '@concilia/core/shared';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { Select } from '../../components/Select';
import { Tabs, type TabItem } from '../../components/Tabs';
import { useAcoes } from './acoes';
import { amountInvalid, useOptions } from './comum';
import { DetalheDrawer } from './Detalhe';
import { ExecutarModal } from './ExecutarModal';
import { ItensTab, useItemCount } from './Itens';
import { SugestoesTab, useSugestoes } from './Sugestoes';
import { EMPTY_FILTERS, type DetailTarget, type Filters, type ItemStatus, type Side } from './tipos';
import './conciliacao.css';

const ABAS = ['sugestoes', 'pendentes', 'divergentes', 'conciliados', 'ignorados'] as const;
type Aba = (typeof ABAS)[number];
const ITEM_STATUS: Record<Exclude<Aba, 'sugestoes'>, ItemStatus> = {
  pendentes: 'pending', divergentes: 'divergent', conciliados: 'reconciled', ignorados: 'ignored',
};

export function ConciliacaoPage() {
  const { can, readOnly } = useAuth();
  const [params, setParams] = useSearchParams();
  const aba: Aba = (ABAS as readonly string[]).includes(params.get('aba') ?? '') ? (params.get('aba') as Aba) : 'sugestoes';
  const lado: Side = params.get('lado') === 'lancamentos' ? 'ledger' : 'bank';
  const awaiting = aba === 'pendentes' && params.get('situacao') === 'awaiting_approval';
  const conta = params.get('conta') ?? '';
  const de = params.get('de') ?? '';
  const ate = params.get('ate') ?? '';

  const setUrl = (patch: Record<string, string>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      return next;
    }, { replace: true });

  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text), 400);
    return () => clearTimeout(t);
  }, [text]);
  const [extra, setExtra] = useState({ kind: '', direction: '', amountMin: '', amountMax: '' });

  const filters: Filters = useMemo(
    () => ({
      ...EMPTY_FILTERS,
      bankAccountId: conta, dateFrom: de, dateTo: ate, q,
      kind: extra.kind, direction: extra.direction,
      amountMin: amountInvalid(extra.amountMin) ? '' : extra.amountMin,
      amountMax: amountInvalid(extra.amountMax) ? '' : extra.amountMax,
    }),
    [conta, de, ate, q, extra],
  );

  const accounts = useOptions('/bank-accounts');
  const acoes = useAcoes();
  const [detail, setDetail] = useState<DetailTarget>(null);
  const canRun = can('reconciliation.run') && !readOnly;
  const canWrite = can('reconciliation.review') && !readOnly;
  const canUndo = can('reconciliation.undo') && !readOnly;
  const [runOpen, setRunOpen] = useState(false);

  const sugestoes = useSugestoes(filters);
  const pend = useItemCount(awaiting ? 'awaiting_approval' : 'pending', filters);
  const div = useItemCount('divergent', filters);
  const conc = useItemCount('reconciled', filters);
  const ign = useItemCount('ignored', filters);

  const tab = (key: Aba, label: string, c: { n: number; capped: boolean } | undefined): TabItem =>
    !c ? { key, label } : c.capped ? { key, label: `${label} (${c.n}+)` } : { key, label, count: c.n };
  const tabs: TabItem[] = [
    tab('sugestoes', 'Sugestões', sugestoes.query.data ? { n: sugestoes.items.length, capped: sugestoes.capped } : undefined),
    tab('pendentes', awaiting ? 'Aguardando aprovação' : 'Pendentes', pend.data),
    tab('divergentes', 'Divergentes', div.data),
    tab('conciliados', 'Conciliados', conc.data),
    tab('ignorados', 'Ignorados', ign.data),
  ];

  const filtered = Object.values(filters).some(Boolean);
  const amountMinBad = amountInvalid(extra.amountMin);
  const amountMaxBad = amountInvalid(extra.amountMax);

  return (
    <>
      <PageHeader
        title="Conciliação"
        subtitle="Revise sugestões, concilie manualmente e acompanhe pendências."
        actions={canRun && <Button variant="primary" onClick={() => setRunOpen(true)}>Executar conciliação</Button>}
      />

      <form className="conc-filtros" role="search" aria-label="Filtros" onSubmit={(e) => e.preventDefault()}>
        <Select
          label="Conta bancária"
          placeholder="Todas"
          value={conta}
          onChange={(e) => setUrl({ conta: e.target.value })}
          options={(accounts.data?.items ?? []).map((a) => ({ value: a.id, label: a.name }))}
        />
        <Field label="De" type="date" value={de} onChange={(e) => setUrl({ de: e.target.value })} />
        <Field label="Até" type="date" value={ate} onChange={(e) => setUrl({ ate: e.target.value })} />
        <Field label="Pesquisar" type="search" placeholder="Descrição, documento, identificador" value={text} onChange={(e) => setText(e.target.value)} />
        <Select
          label="Tipo"
          placeholder="Todos"
          value={extra.kind}
          onChange={(e) => setExtra({ ...extra, kind: e.target.value })}
          options={ITEM_KINDS.map((k) => ({ value: k, label: ITEM_KIND_LABELS[k] }))}
        />
        <Select
          label="Direção"
          placeholder="Todas"
          value={extra.direction}
          onChange={(e) => setExtra({ ...extra, direction: e.target.value })}
          options={[{ value: 'credit', label: 'Entradas' }, { value: 'debit', label: 'Saídas' }]}
        />
        <Field label="Valor mínimo (R$)" inputMode="decimal" value={extra.amountMin} error={amountMinBad ? 'Valor inválido.' : null} onChange={(e) => setExtra({ ...extra, amountMin: e.target.value })} />
        <Field label="Valor máximo (R$)" inputMode="decimal" value={extra.amountMax} error={amountMaxBad ? 'Valor inválido.' : null} onChange={(e) => setExtra({ ...extra, amountMax: e.target.value })} />
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => { setText(''); setQ(''); setExtra({ kind: '', direction: '', amountMin: '', amountMax: '' }); setUrl({ conta: '', de: '', ate: '' }); }}
          >
            Limpar filtros
          </Button>
        )}
      </form>

      <Tabs
        label="Situação da conciliação"
        tabs={tabs}
        value={aba}
        onChange={(key) => setUrl({ aba: key, situacao: key === 'pendentes' ? params.get('situacao') ?? '' : '' })}
      />

      <div className="conc-painel" role="tabpanel">
        {awaiting && (
          <p className="conc-aviso">
            Exibindo itens aguardando aprovação.{' '}
            <Button size="sm" variant="ghost" onClick={() => setUrl({ situacao: '' })}>Ver pendentes</Button>
          </p>
        )}
        {aba === 'sugestoes' ? (
          <SugestoesTab data={sugestoes} acoes={acoes} canWrite={canWrite} onDetail={(id) => setDetail({ type: 'match', id })} />
        ) : (
          <ItensTab
            status={awaiting ? 'awaiting_approval' : ITEM_STATUS[aba]}
            filters={filters}
            acoes={acoes}
            canWrite={canWrite}
            canUndo={canUndo}
            lado={lado}
            onLado={(l) => setUrl({ lado: l === 'ledger' ? 'lancamentos' : 'extrato' })}
            onDetail={(side, id) => setDetail({ type: 'item', side, id })}
          />
        )}
      </div>

      <DetalheDrawer target={detail} onClose={() => setDetail(null)} acoes={acoes} />
      {acoes.dialogs}
      {canRun && <ExecutarModal key={String(runOpen)} open={runOpen} onClose={() => setRunOpen(false)} initial={{ bankAccountId: conta, dateFrom: de, dateTo: ate }} />}
    </>
  );
}
