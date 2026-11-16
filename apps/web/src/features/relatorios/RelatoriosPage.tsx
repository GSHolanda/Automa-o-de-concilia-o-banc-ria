import { ITEM_KIND_LABELS, ITEM_KINDS } from '@concilia/core/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, type Page } from '../../api/client';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { Select } from '../../components/Select';
import { useToast } from '../../components/Toast';
import { amountInvalid, centsOf, useOptions } from '../conciliacao/comum';

interface Template { id: string; name: string; kind: 'items' | 'summary'; isDefault?: boolean }

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pendente' },
  { value: 'divergent', label: 'Divergente' },
  { value: 'reconciled', label: 'Conciliado' },
  { value: 'ignored', label: 'Ignorado' },
  { value: 'awaiting_approval', label: 'Aguardando aprovação' },
];

function useTemplates(kind: 'items' | 'summary') {
  return useQuery({
    queryKey: ['report-templates', 'options'],
    staleTime: 60_000,
    queryFn: () => api.get<Page<Template>>('/report-templates', { limit: 200 }),
    select: (page) => page.items.filter((t) => t.kind === kind),
  });
}

function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

/** Envia o POST e baixa o arquivo; trata arquivo grande demais. */
function useExport(path: string, fallbackName: string) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(body: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api.downloadPost(path, body, fallbackName);
      toast.success('Arquivo gerado. A exportação foi registrada na auditoria.');
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && e.code === 'export_too_large') {
        setError('O arquivo ficaria grande demais. Restrinja o período (ou os filtros) e gere novamente.');
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function Erro({ text }: { text: string | null }) {
  return text ? <p className="campo-erro" role="alert">{text}</p> : null;
}

function ItensBloco() {
  const accounts = useOptions('/bank-accounts');
  const templates = useTemplates('items');
  const exp = useExport('/exports/items', 'itens-conciliacao');
  const [f, setF] = useState({
    format: 'xlsx', side: '', bankAccountId: '', status: '', kind: '', direction: '',
    dateFrom: '', dateTo: '', amountMin: '', amountMax: '', q: '', templateId: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const periodError = f.dateFrom && f.dateTo && f.dateFrom > f.dateTo ? 'A data inicial deve ser anterior à final.' : null;
  const invalid = amountInvalid(f.amountMin) || amountInvalid(f.amountMax) || !!periodError;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    void exp.run({
      format: f.format,
      templateId: f.templateId || undefined,
      filters: clean({
        side: f.side || undefined, bankAccountId: f.bankAccountId, status: f.status || undefined,
        kind: f.kind || undefined, direction: f.direction || undefined, dateFrom: f.dateFrom, dateTo: f.dateTo,
        amountMin: centsOf(f.amountMin), amountMax: centsOf(f.amountMax), q: f.q.trim(),
      }),
    });
  }

  return (
    <section className="pilha" aria-labelledby="rel-itens">
      <h2 id="rel-itens">Itens</h2>
      <p className="texto-suave">Exporta os itens de extrato e lançamentos que atendem aos filtros.</p>
      <form className="pilha" onSubmit={submit}>
        <div className="grade">
          <Select label="Origem" value={f.side} onChange={set('side')} placeholder="Todas"
            options={[{ value: 'bank', label: 'Extrato' }, { value: 'ledger', label: 'Lançamentos' }]} />
          <Select label="Conta bancária" value={f.bankAccountId} onChange={set('bankAccountId')} placeholder="Todas"
            options={(accounts.data?.items ?? []).map((a) => ({ value: a.id, label: a.name }))} />
          <Select label="Situação" value={f.status} onChange={set('status')} placeholder="Todas" options={STATUS_OPTIONS} />
          <Select label="Tipo" value={f.kind} onChange={set('kind')} placeholder="Todos"
            options={ITEM_KINDS.map((k) => ({ value: k, label: ITEM_KIND_LABELS[k] }))} />
          <Select label="Direção" value={f.direction} onChange={set('direction')} placeholder="Entradas e saídas"
            options={[{ value: 'credit', label: 'Entradas' }, { value: 'debit', label: 'Saídas' }]} />
          <Field label="Período de" type="date" value={f.dateFrom} onChange={set('dateFrom')} />
          <Field label="Período até" type="date" value={f.dateTo} onChange={set('dateTo')} error={periodError} />
          <Field label="Valor mínimo (R$)" inputMode="decimal" value={f.amountMin} onChange={set('amountMin')}
            error={amountInvalid(f.amountMin) ? 'Valor inválido.' : null} />
          <Field label="Valor máximo (R$)" inputMode="decimal" value={f.amountMax} onChange={set('amountMax')}
            error={amountInvalid(f.amountMax) ? 'Valor inválido.' : null} />
          <Field label="Texto" value={f.q} maxLength={120} onChange={set('q')} hint="Busca na descrição, documento e referência." />
          <Select label="Formato" value={f.format} onChange={set('format')}
            options={[{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'XLSX' }, { value: 'pdf', label: 'PDF' }]} />
          <Select label="Modelo de relatório" value={f.templateId} onChange={set('templateId')} placeholder="Padrão"
            options={(templates.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />
        </div>
        <Erro text={exp.error} />
        <div><Button type="submit" loading={exp.busy} disabled={invalid}>Gerar arquivo de itens</Button></div>
      </form>
    </section>
  );
}

function ResumoBloco() {
  const accounts = useOptions('/bank-accounts');
  const templates = useTemplates('summary');
  const exp = useExport('/exports/summary', 'resumo-conciliacao');
  const [f, setF] = useState({ format: 'pdf', bankAccountId: '', dateFrom: '', dateTo: '', templateId: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const periodError = f.dateFrom && f.dateTo && f.dateFrom > f.dateTo ? 'A data inicial deve ser anterior à final.' : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (periodError) return;
    void exp.run({
      format: f.format, bankAccountId: f.bankAccountId, dateFrom: f.dateFrom, dateTo: f.dateTo,
      templateId: f.templateId || undefined,
    });
  }

  return (
    <section className="pilha" aria-labelledby="rel-resumo">
      <h2 id="rel-resumo">Resumo da conciliação</h2>
      <p className="texto-suave">Situação da conciliação de uma conta em um período.</p>
      <form className="pilha" onSubmit={submit}>
        <div className="grade">
          <Select label="Conta bancária" required value={f.bankAccountId} onChange={set('bankAccountId')} placeholder="Selecione"
            options={(accounts.data?.items ?? []).map((a) => ({ value: a.id, label: a.name }))} />
          <Field label="Período de" type="date" required value={f.dateFrom} onChange={set('dateFrom')} />
          <Field label="Período até" type="date" required value={f.dateTo} onChange={set('dateTo')} error={periodError} />
          <Select label="Formato" value={f.format} onChange={set('format')}
            options={[{ value: 'pdf', label: 'PDF' }, { value: 'xlsx', label: 'XLSX' }]} />
          <Select label="Modelo de relatório" value={f.templateId} onChange={set('templateId')} placeholder="Padrão"
            options={(templates.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />
        </div>
        <Erro text={exp.error} />
        <div><Button type="submit" loading={exp.busy} disabled={!f.bankAccountId || !f.dateFrom || !f.dateTo}>Gerar resumo</Button></div>
      </form>
    </section>
  );
}

function PendentesBloco() {
  const accounts = useOptions('/bank-accounts');
  const exp = useExport('/exports/pending-entries', 'lancamentos-a-registrar');
  const [f, setF] = useState({ format: 'csv', bankAccountId: '', dateFrom: '', dateTo: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const periodError = f.dateFrom && f.dateTo && f.dateFrom > f.dateTo ? 'A data inicial deve ser anterior à final.' : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (periodError) return;
    void exp.run(clean({ format: f.format, bankAccountId: f.bankAccountId, dateFrom: f.dateFrom, dateTo: f.dateTo }));
  }

  return (
    <section className="pilha" aria-labelledby="rel-pend">
      <h2 id="rel-pend">Lançamentos a criar</h2>
      <p className="texto-suave">
        Classificações confirmadas que ainda não têm lançamento correspondente. O arquivo serve para lançar essas
        movimentações no sistema financeiro; o Concilia não altera o sistema de origem.
      </p>
      <form className="pilha" onSubmit={submit}>
        <div className="grade">
          <Select label="Conta bancária" value={f.bankAccountId} onChange={set('bankAccountId')} placeholder="Todas"
            options={(accounts.data?.items ?? []).map((a) => ({ value: a.id, label: a.name }))} />
          <Field label="Período de" type="date" value={f.dateFrom} onChange={set('dateFrom')} />
          <Field label="Período até" type="date" value={f.dateTo} onChange={set('dateTo')} error={periodError} />
          <Select label="Formato" value={f.format} onChange={set('format')}
            options={[{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'XLSX' }]} />
        </div>
        <Erro text={exp.error} />
        <div><Button type="submit" loading={exp.busy}>Gerar lançamentos a criar</Button></div>
      </form>
    </section>
  );
}

export function RelatoriosPage() {
  return (
    <div className="pilha">
      <PageHeader title="Relatórios" subtitle="Exporte itens, resumos e lançamentos a criar. Toda exportação fica registrada na auditoria." />
      <ItensBloco />
      <ResumoBloco />
      <PendentesBloco />
    </div>
  );
}
