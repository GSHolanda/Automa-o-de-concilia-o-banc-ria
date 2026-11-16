import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage, type Page } from '../../api/client';
import { useAuth } from '../../auth';
import { Button } from '../../components/Button';
import { DataTable, type Column } from '../../components/DataTable';
import { DateText } from '../../components/DateText';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { Select } from '../../components/Select';
import {
  BatchStatusBadge, FORMAT_LABEL, IMPORTS_KEY, isRunning, SOURCE_LABEL, STATUS_LABEL, useUserNames,
  type BatchStatus, type ImportBatch,
} from './comum';

const PAGE_SIZE = 25;

export function ImportacoesPage() {
  const { can, readOnly } = useAuth();
  const navigate = useNavigate();
  const userName = useUserNames();
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];

  const list = useQuery({
    queryKey: [...IMPORTS_KEY, 'list', { source, status, cursor }],
    queryFn: () =>
      api.get<Page<ImportBatch>>('/imports', { sourceKind: source, status, cursor, limit: PAGE_SIZE }),
    placeholderData: (previous) => previous,
    // Atualiza sozinho enquanto houver lote na fila ou em processamento.
    refetchInterval: (query) => (query.state.data?.items.some((b) => isRunning(b.status)) ? 2000 : false),
  });

  const resetPaging = () => setCursors([undefined]);
  const canCreate = can('imports.create') && !readOnly;
  const next = list.data?.nextCursor ?? undefined;

  const columns: Column<ImportBatch>[] = [
    { key: 'file', header: 'Arquivo', render: (b) => <Link to={`/importacoes/${b.id}`}><strong>{b.fileName}</strong></Link> },
    { key: 'source', header: 'Origem', render: (b) => SOURCE_LABEL[b.sourceKind], hideOnMobile: true },
    { key: 'account', header: 'Conta', render: (b) => b.bankAccountName ?? '—', hideOnMobile: true },
    { key: 'format', header: 'Formato', render: (b) => FORMAT_LABEL[b.fileFormat] ?? b.fileFormat, hideOnMobile: true },
    { key: 'status', header: 'Situação', render: (b) => <BatchStatusBadge status={b.status} /> },
    { key: 'imported', header: 'Importados', align: 'right', render: (b) => b.stats.imported ?? '—' },
    { key: 'dup', header: 'Duplicados', align: 'right', hideOnMobile: true, render: (b) => b.stats.duplicates ?? '—' },
    { key: 'rej', header: 'Rejeitados', align: 'right', hideOnMobile: true, render: (b) => b.stats.rejected ?? '—' },
    { key: 'date', header: 'Data', hideOnMobile: true, render: (b) => <DateText value={b.createdAt} withTime /> },
    { key: 'author', header: 'Autor', hideOnMobile: true, render: (b) => userName(b.createdBy) },
  ];

  const newButton = (
    <Button variant="primary" disabled={!canCreate} onClick={() => navigate('/importacoes/nova')}>Nova importação</Button>
  );

  return (
    <>
      <PageHeader
        title="Importações"
        subtitle="Arquivos de extrato e de lançamentos enviados para conciliação."
        actions={newButton}
      />
      <div className="linha" style={{ alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 'var(--e4)' }}>
        <Select label="Origem" value={source} placeholder="Todas"
          onChange={(e) => { setSource(e.target.value); resetPaging(); }}
          options={[{ value: 'bank', label: SOURCE_LABEL.bank }, { value: 'ledger', label: SOURCE_LABEL.ledger }]} />
        <Select label="Situação" value={status} placeholder="Todas"
          onChange={(e) => { setStatus(e.target.value); resetPaging(); }}
          options={(Object.keys(STATUS_LABEL) as BatchStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
      </div>
      <DataTable
        caption="Lotes de importação"
        columns={columns}
        rows={list.data?.items}
        rowKey={(b) => b.id}
        loading={list.isLoading}
        error={list.isError ? errorMessage(list.error) : null}
        onRetry={() => void list.refetch()}
        onRowClick={(b) => navigate(`/importacoes/${b.id}`)}
        emptyTitle="Nenhuma importação encontrada"
        emptyDescription={source || status ? 'Nenhum lote corresponde aos filtros.' : 'Envie o primeiro arquivo de extrato ou de lançamentos.'}
        emptyAction={!source && !status && canCreate ? newButton : undefined}
        footer={
          <Pagination
            hasPrev={cursors.length > 1}
            hasNext={Boolean(next)}
            onPrev={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => next && setCursors((c) => [...c, next])}
            summary={`Página ${cursors.length}`}
            loading={list.isFetching}
          />
        }
      />
    </>
  );
}
