import { INTEGRATION_KINDS, INTEGRATION_MODULES, type IntegrationKind } from '@concilia/core/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DateText } from '../../components/DateText';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { Spinner } from '../../components/Spinner';
import { useWrite } from '../shared';
import { IntegrationStatusBadge, detailedError } from './comum';
import { IntegracaoForm, KIND_INFO, type Integration } from './IntegracaoForm';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface JobView {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'dead' | 'canceled';
  lastError: string | null;
  result: { batchId?: string; items?: number; duplicate?: boolean; skipped?: boolean; reason?: string } | null;
}

/** Busca de lançamentos no conector REST: pede o período e acompanha o trabalho até o fim. */
function BuscarModal({ item, onClose }: { item: Integration; onClose: () => void }) {
  const [dateFrom, setDateFrom] = useState(`${today().slice(0, 8)}01`);
  const [dateTo, setDateTo] = useState(today());
  const [jobId, setJobId] = useState<string | null>(null);
  const start = useWrite<void, { jobId: string }>({
    inlineError: true,
    invalidate: [],
    mutationFn: () => api.post(`/integrations/${item.id}/pull`, { dateFrom, dateTo }),
    onSuccess: (r) => setJobId(r.jobId),
  });
  const job = useQuery({
    queryKey: ['jobs', jobId],
    enabled: jobId !== null,
    queryFn: ({ signal }) => api.get<JobView>(`/jobs/${jobId}`, undefined, signal),
    refetchInterval: (q) => (q.state.data && ['succeeded', 'dead', 'canceled'].includes(q.state.data.status) ? false : 2000),
  });
  const status = job.data?.status;
  const finished = status === 'succeeded' || status === 'dead' || status === 'canceled';
  const invalid = !dateFrom || !dateTo || dateTo < dateFrom;
  const result = job.data?.result;

  return (
    <Modal
      open
      size="sm"
      title="Buscar lançamentos"
      onClose={onClose}
      footer={
        jobId ? (
          <Button variant="primary" onClick={onClose}>{finished ? 'Fechar' : 'Fechar e acompanhar depois'}</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="primary" disabled={invalid} loading={start.isPending} onClick={() => start.mutate()}>Buscar</Button>
          </>
        )
      }
    >
      {!jobId ? (
        <div className="pilha">
          <p>Conector: <strong>{item.name}</strong>. Os lançamentos do período entram como um lote de importação.</p>
          <Field label="Início do período" type="date" required value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <Field
            label="Fim do período"
            type="date"
            required
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            error={dateTo && dateTo < dateFrom ? 'O fim deve ser igual ou posterior ao início.' : null}
            hint="Período máximo de 366 dias."
          />
          {start.errorText && <p className="campo-erro" role="alert">{detailedError(start.error)}</p>}
        </div>
      ) : (
        <div className="pilha" aria-live="polite">
          {job.isError && <p className="campo-erro" role="alert">{errorMessage(job.error)}</p>}
          {!finished && !job.isError && <p className="linha"><Spinner inline label="Aguarde" /> {status === 'running' ? 'Buscando…' : 'Na fila, aguardando execução…'}</p>}
          {(status === 'dead' || status === 'canceled') && <p className="campo-erro" role="alert">A busca falhou. {job.data?.lastError ?? ''}</p>}
          {status === 'succeeded' && result?.skipped && <p>Busca ignorada: {result.reason}</p>}
          {status === 'succeeded' && !result?.skipped && (
            <p>
              <strong>Busca concluída.</strong> {result?.items ?? 0} lançamento(s) recebido(s)
              {result?.duplicate ? ' (conteúdo já importado antes)' : ''}.{' '}
              {result?.batchId && <Link to={`/importacoes/${result.batchId}`}>Ver o lote</Link>}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function IntegrationCard({ item, writable, onEdit, onPull }: { item: Integration; writable: boolean; onEdit: () => void; onPull: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const test = useWrite<void, Integration>({
    invalidate: [['integrations']],
    mutationFn: () => api.post(`/integrations/${item.id}/test`),
    success: (r) => (r.status === 'verified' ? 'Conexão verificada.' : 'O teste não foi bem-sucedido.'),
  });
  const del = useWrite({
    invalidate: [['integrations']],
    mutationFn: () => api.delete(`/integrations/${item.id}`),
    success: 'Integração excluída.',
    onSuccess: () => setConfirmDelete(false),
  });
  const summary =
    item.kind === 'webhook' ? String(item.config.url ?? '')
    : item.kind === 'smtp' ? `${String(item.config.host ?? '')}:${String(item.config.port ?? '')}`
    : item.kind === 'rest_ledger' ? `${String(item.config.baseUrl ?? '')}${String(item.config.path ?? '')}`
    : `${String(item.config.provider ?? '')} · ${String(item.config.model ?? '')}`;

  return (
    <article className="cartao pilha" aria-label={`Integração ${item.name}`}>
      <div className="linha" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{item.name}</h3>
        <span className="linha">
          <IntegrationStatusBadge status={item.status} />
          {!item.active && <Badge>Inativa</Badge>}
        </span>
      </div>
      <p className="texto-suave" style={{ margin: 0, wordBreak: 'break-all' }}>{summary}</p>
      <p style={{ margin: 0 }}>
        Segredo: {item.hasSecret ? <Badge tone="success">Configurado</Badge> : <Badge>Não configurado</Badge>}
        {item.lastCheckedAt && <span className="texto-suave"> · Último teste: <DateText value={item.lastCheckedAt} withTime /></span>}
      </p>
      {item.lastError && <p className="erro-texto" style={{ margin: 0 }}><strong>Último erro:</strong> {item.lastError}</p>}
      {writable && (
        <div className="linha" style={{ flexWrap: 'wrap' }}>
          <Button size="sm" onClick={onEdit}>Editar<span className="sr-only"> {item.name}</span></Button>
          <Button size="sm" variant="primary" loading={test.isPending} disabled={!item.active} onClick={() => test.mutate()}>
            Testar conexão<span className="sr-only"> {item.name}</span>
          </Button>
          {item.kind === 'rest_ledger' && (
            <Button size="sm" disabled={!item.active || item.status === 'not_configured'} onClick={onPull}>Buscar lançamentos<span className="sr-only"> {item.name}</span></Button>
          )}
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>Excluir<span className="sr-only"> {item.name}</span></Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Excluir integração"
        message={`Excluir a integração ${item.name}? Regras de notificação que a usam deixarão de funcionar.`}
        confirmLabel="Excluir"
        destructive
        onConfirm={() => del.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </article>
  );
}

export function IntegracoesPage() {
  const { can, readOnly, hasModule } = useAuth();
  const writable = can('integrations.manage') && !readOnly;
  const list = useQuery({ queryKey: ['integrations'], queryFn: () => api.get<{ items: Integration[] }>('/integrations') });
  const [form, setForm] = useState<{ kind: IntegrationKind; item: Integration | null } | null>(null);
  const [pull, setPull] = useState<Integration | null>(null);

  return (
    <>
      <PageHeader title="Integrações" subtitle="Conexões com serviços externos. Segredos são só de escrita: depois de salvos, nunca são exibidos." />
      <p className="texto-suave">
        A situação <strong>Verificada</strong> só aparece depois que o serviço responde de verdade a um teste de conexão.
        Salvar a configuração não verifica nada.
      </p>
      {list.isLoading && <Spinner label="Carregando integrações" />}
      {list.isError && (
        <EmptyState tone="error" title="Não foi possível carregar as integrações" description={errorMessage(list.error)} action={<Button onClick={() => void list.refetch()}>Tentar novamente</Button>} />
      )}
      {list.data && INTEGRATION_KINDS.map((kind) => {
        const info = KIND_INFO[kind];
        const enabled = hasModule(INTEGRATION_MODULES[kind]);
        const items = list.data.items.filter((i) => i.kind === kind);
        return (
          <section key={kind} className="pilha" aria-labelledby={`tipo-${kind}`} style={{ marginBottom: 'var(--e5)' }}>
            <div className="linha" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div>
                <h2 id={`tipo-${kind}`} style={{ margin: 0 }}>{info.label}</h2>
                <p className="texto-suave" style={{ margin: 0 }}>{info.description}</p>
              </div>
              {enabled && writable && <Button variant="primary" onClick={() => setForm({ kind, item: null })}>Nova integração<span className="sr-only"> {info.label}</span></Button>}
            </div>
            {!enabled && (
              <div className="faixa-aviso" role="status">
                O módulo correspondente não está ativo para a empresa. <Link to="/configuracoes/modulos">Ir para Módulos</Link>
              </div>
            )}
            {kind === 'ai_provider' && (
              <p className="texto-suave" style={{ margin: 0 }}>
                As sugestões da IA sempre passam por aceite humano. São enviados ao provedor apenas a descrição normalizada, o sinal e o tipo da transação.
              </p>
            )}
            {enabled && items.length === 0 && <EmptyState title="Nenhuma integração cadastrada" description={`Cadastre ${info.singular === 'webhook' ? 'um webhook' : `um ${info.singular}`} para começar.`} />}
            {enabled && items.map((item) => (
              <IntegrationCard key={item.id} item={item} writable={writable} onEdit={() => setForm({ kind, item })} onPull={() => setPull(item)} />
            ))}
          </section>
        );
      })}
      {form && <IntegracaoForm key={form.item?.id ?? 'novo'} kind={form.kind} item={form.item} onClose={() => setForm(null)} />}
      {pull && <BuscarModal item={pull} onClose={() => setPull(null)} />}
    </>
  );
}
