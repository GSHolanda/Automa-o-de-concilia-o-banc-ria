import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage, type Page } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { DateText } from '../../components/DateText';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useWrite } from '../shared';
import {
  BatchStatusBadge, formatBytes, FORMAT_LABEL, IMPORTS_KEY, isRunning, JOB_LABEL, SOURCE_LABEL, useUserNames,
  type ImportBatch,
} from './comum';

interface Rejection {
  id: number;
  rowNumber: number;
  kind: 'invalid' | 'conflict';
  reason: string;
  raw: unknown;
}

const KIND_LABEL = { invalid: 'Inválida', conflict: 'Conflito' } as const;
const PAGE_SIZE = 50;

function Stat({ label, value }: { label: string; value: number | string | undefined | null }) {
  return (
    <div className="cartao" style={{ padding: 'var(--e4)' }}>
      <div className="texto-suave">{label}</div>
      <strong style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{value ?? '—'}</strong>
    </div>
  );
}

export function ImportacaoDetalhePage() {
  const { id = '' } = useParams();
  const { can, readOnly } = useAuth();
  const toast = useToast();
  const userName = useUserNames();
  const canWrite = can('imports.create') && !readOnly;
  const [confirmReprocess, setConfirmReprocess] = useState(false);
  const [kind, setKind] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];

  const batchQuery = useQuery({
    queryKey: [...IMPORTS_KEY, 'detail', id],
    queryFn: ({ signal }) => api.get<ImportBatch>(`/imports/${id}`, undefined, signal),
    refetchInterval: (q) => (isRunning(q.state.data?.status) || q.state.data?.job?.status === 'running' ? 2000 : false),
  });
  const batch = batchQuery.data;

  const rejections = useQuery({
    queryKey: [...IMPORTS_KEY, 'rejections', id, { kind, cursor }],
    enabled: Boolean(batch) && (batch?.stats.rejected ?? 0) + (batch?.stats.conflicts ?? 0) > 0 || batch?.status === 'completed_with_errors',
    queryFn: () => api.get<Page<Rejection>>(`/imports/${id}/rejections`, { kind, cursor, limit: PAGE_SIZE }),
    placeholderData: (p) => p,
  });

  const reprocess = useWrite({
    mutationFn: () => api.post(`/imports/${id}/reprocess`, {}),
    invalidate: [IMPORTS_KEY],
    success: 'Reprocessamento solicitado.',
    onSuccess: () => setConfirmReprocess(false),
  });
  const retry = useWrite({
    mutationFn: (jobId: string) => api.post(`/jobs/${jobId}/retry`),
    invalidate: [IMPORTS_KEY],
    success: 'Trabalho devolvido à fila.',
  });

  if (batchQuery.isLoading) return <Spinner label="Carregando importação" />;
  if (batchQuery.isError || !batch) {
    const notFound = batchQuery.error instanceof ApiError && batchQuery.error.status === 404;
    return (
      <EmptyState
        title={notFound ? 'Importação não encontrada' : 'Não foi possível carregar a importação'}
        description={notFound ? undefined : errorMessage(batchQuery.error)}
        action={
          <>
            {!notFound && <Button onClick={() => void batchQuery.refetch()}>Tentar de novo</Button>}
            <Link to="/importacoes">Voltar para importações</Link>
          </>
        }
      />
    );
  }

  const canReprocess = ['completed', 'completed_with_errors', 'failed'].includes(batch.status);
  const s = batch.stats;
  const hasRejections = (s.rejected ?? 0) + (s.conflicts ?? 0) > 0 || batch.status === 'completed_with_errors';
  const next = rejections.data?.nextCursor ?? undefined;

  const columns: Column<Rejection>[] = [
    { key: 'row', header: 'Linha', align: 'right', render: (r) => r.rowNumber },
    { key: 'kind', header: 'Tipo', render: (r) => <Badge tone={r.kind === 'invalid' ? 'danger' : 'warning'}>{KIND_LABEL[r.kind] ?? r.kind}</Badge> },
    { key: 'reason', header: 'Motivo', render: (r) => r.reason },
    {
      key: 'raw',
      header: 'Dados brutos',
      hideOnMobile: true,
      render: (r) => (
        <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{typeof r.raw === 'string' ? r.raw : JSON.stringify(r.raw)}</code>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={batch.fileName}
        subtitle={`${SOURCE_LABEL[batch.sourceKind]} · ${FORMAT_LABEL[batch.fileFormat] ?? batch.fileFormat} · ${formatBytes(batch.fileSize)}`}
        actions={
          <>
            <Link to="/importacoes">Voltar</Link>
            <Button onClick={() => api.download(`/imports/${id}/file`, undefined, batch.fileName).catch((e) => toast.error(errorMessage(e)))}>
              Baixar arquivo original
            </Button>
            {canWrite && (
              <Button variant="primary" disabled={!canReprocess} onClick={() => setConfirmReprocess(true)}>Reprocessar</Button>
            )}
          </>
        }
      />

      <div className="cartao pilha" style={{ padding: 'var(--e4)', marginBottom: 'var(--e4)' }}>
        <div className="linha" style={{ flexWrap: 'wrap', gap: 'var(--e5)' }}>
          <span><span className="texto-suave">Situação </span><BatchStatusBadge status={batch.status} /></span>
          <span><span className="texto-suave">Conta </span>{batch.bankAccountName ?? '—'}</span>
          <span><span className="texto-suave">Enviado em </span><DateText value={batch.createdAt} withTime /></span>
          {batch.processedAt && <span><span className="texto-suave">Processado em </span><DateText value={batch.processedAt} withTime /></span>}
          <span><span className="texto-suave">Autor </span>{userName(batch.createdBy)}</span>
          {(s.periodStart || s.periodEnd) && (
            <span><span className="texto-suave">Período </span>{s.periodStart ? <DateText value={s.periodStart} /> : '—'} a {s.periodEnd ? <DateText value={s.periodEnd} /> : '—'}</span>
          )}
        </div>
        {batch.status === 'uploaded' && (
          <p className="texto-suave">Este lote ainda não foi confirmado. Inicie uma nova importação para enviá-lo novamente.</p>
        )}
        {isRunning(batch.status) && <p role="status"><Spinner label="Processamento em andamento" /> Atualizando automaticamente…</p>}
        {batch.error && (
          <p className="erro-texto" role="alert"><strong>Erro: </strong>{batch.error}</p>
        )}
      </div>

      <div style={{ display: 'grid', gap: 'var(--e3)', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 'var(--e4)' }}>
        <Stat label="Linhas lidas" value={s.totalRows} />
        <Stat label="Importados" value={s.imported} />
        <Stat label="Duplicados" value={s.duplicates} />
        <Stat label="Rejeitados" value={s.rejected} />
        <Stat label="Conflitos" value={s.conflicts} />
        <Stat label="Ignorados" value={s.skipped} />
        <Stat label="Suspeitas de duplicidade" value={s.duplicateSuspects} />
      </div>

      {batch.job && (
        <div className="cartao" style={{ padding: 'var(--e4)', marginBottom: 'var(--e4)' }}>
          <div className="linha" style={{ flexWrap: 'wrap', gap: 'var(--e4)' }}>
            <strong>Trabalho na fila</strong>
            <Badge tone={batch.job.status === 'dead' ? 'danger' : batch.job.status === 'succeeded' ? 'success' : 'info'}>
              {JOB_LABEL[batch.job.status] ?? batch.job.status}
            </Badge>
            <span className="texto-suave">Tentativas: {batch.job.attempts ?? 0}</span>
            {batch.job.status === 'dead' && canWrite && (
              <Button size="sm" variant="primary" loading={retry.isPending} onClick={() => retry.mutate(batch.job!.id)}>
                Tentar de novo
              </Button>
            )}
          </div>
          {batch.job.lastError && <p className="erro-texto" style={{ marginTop: 'var(--e2)' }}>Último erro: {batch.job.lastError}</p>}
        </div>
      )}

      {hasRejections && (
        <section aria-labelledby="titulo-rejeicoes">
          <div className="linha" style={{ alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <h2 id="titulo-rejeicoes">Rejeições</h2>
            <Select label="Tipo" value={kind} placeholder="Todos"
              onChange={(e) => { setKind(e.target.value); setCursors([undefined]); }}
              options={[{ value: 'invalid', label: 'Inválida' }, { value: 'conflict', label: 'Conflito' }]} />
          </div>
          <DataTable
            caption="Linhas rejeitadas"
            columns={columns}
            rows={rejections.data?.items}
            rowKey={(r) => String(r.id)}
            loading={rejections.isLoading}
            error={rejections.isError ? errorMessage(rejections.error) : null}
            onRetry={() => void rejections.refetch()}
            emptyTitle="Nenhuma rejeição"
            footer={
              <Pagination
                hasPrev={cursors.length > 1}
                hasNext={Boolean(next)}
                onPrev={() => setCursors((c) => c.slice(0, -1))}
                onNext={() => next && setCursors((c) => [...c, next])}
                summary={`Página ${cursors.length}`}
                loading={rejections.isFetching}
              />
            }
          />
        </section>
      )}

      <ConfirmDialog
        open={confirmReprocess}
        title="Reprocessar importação"
        message="O arquivo original será lido de novo com o mesmo mapeamento. Registros já importados não são duplicados."
        confirmLabel="Reprocessar"
        onCancel={() => setConfirmReprocess(false)}
        onConfirm={async () => { await reprocess.mutateAsync().catch(() => undefined); }}
      />
    </>
  );
}
