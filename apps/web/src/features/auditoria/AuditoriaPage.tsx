import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorMessage, type Page } from '../../api/client';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { DataTable, type Column } from '../../components/DataTable';
import { DateText } from '../../components/DateText';
import { Drawer } from '../../components/Drawer';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useWrite } from '../shared';

interface AuditItem {
  seq: number;
  occurredAt: string;
  actorType: string;
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
  requestId: string | null;
  ip: string | null;
  hash: string;
}

interface ChainCheck {
  intact: boolean;
  checked: number;
  brokenSeq: number | null;
  headSeq: number | null;
  headHash: string | null;
}

interface Filters { action: string; entityType: string; from: string; to: string }
const EMPTY: Filters = { action: '', entityType: '', from: '', to: '' };
const PAGE_SIZE = 50;

const ACTOR_LABEL: Record<string, string> = { user: 'Usuário', system: 'Sistema', platform: 'Plataforma', token: 'Token de API' };

export function AuditoriaPage() {
  const toast = useToast();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  // Pilha de cursores: o último é o da página atual (undefined = primeira).
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [detail, setDetail] = useState<AuditItem | null>(null);
  const [check, setCheck] = useState<ChainCheck | null>(null);
  const cursor = cursors[cursors.length - 1];

  const list = useQuery({
    queryKey: ['audit', filters, cursor],
    queryFn: () =>
      api.get<Page<AuditItem>>('/audit', {
        action: filters.action.trim(),
        entityType: filters.entityType.trim(),
        from: filters.from,
        to: filters.to,
        limit: PAGE_SIZE,
        cursor,
      }),
    placeholderData: (previous) => previous,
  });

  const verify = useWrite({
    mutationFn: () => api.get<ChainCheck>('/audit/verify'),
    invalidate: [],
    onSuccess: setCheck,
  });

  function apply(e: FormEvent) {
    e.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) {
      toast.error('A data inicial não pode ser posterior à final.');
      return;
    }
    setFilters(draft);
    setCursors([undefined]);
  }
  function clear() {
    setDraft(EMPTY);
    setFilters(EMPTY);
    setCursors([undefined]);
  }

  const columns: Column<AuditItem>[] = [
    { key: 'when', header: 'Data', render: (a) => <DateText value={a.occurredAt} withTime />, width: '11rem' },
    { key: 'actor', header: 'Autor', render: (a) => a.actorLabel ?? ACTOR_LABEL[a.actorType] ?? a.actorType, hideOnMobile: true },
    { key: 'action', header: 'Ação', render: (a) => <code>{a.action}</code> },
    { key: 'entity', header: 'Entidade', render: (a) => a.entityType, hideOnMobile: true },
    { key: 'summary', header: 'Resumo', render: (a) => a.summary },
  ];

  const items = list.data?.items;
  const page = cursors.length;

  return (
    <>
      <PageHeader
        title="Auditoria"
        subtitle="Trilha encadeada de tudo o que altera dados da empresa."
        actions={<Button loading={verify.isPending} onClick={() => verify.mutate()}>Verificar integridade</Button>}
      />
      <div className="pilha">
        <form className="cartao" onSubmit={apply} aria-label="Filtros da auditoria">
          <div className="grade-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <Field label="Ação" placeholder="ex.: user.created" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
            <Field label="Tipo de entidade" placeholder="ex.: user" value={draft.entityType} onChange={(e) => setDraft({ ...draft, entityType: e.target.value })} />
            <Field label="De" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            <Field label="Até" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </div>
          <div className="linha" style={{ marginTop: 'var(--e3)' }}>
            <Button type="submit" variant="primary">Filtrar</Button>
            <Button onClick={clear}>Limpar</Button>
          </div>
        </form>

        <DataTable
          caption="Registros de auditoria"
          columns={columns}
          rows={items}
          rowKey={(a) => String(a.seq)}
          loading={list.isLoading}
          error={list.isError ? errorMessage(list.error) : null}
          onRetry={() => void list.refetch()}
          emptyTitle="Nenhum registro encontrado"
          emptyDescription="Ajuste os filtros para ampliar a busca."
          onRowClick={setDetail}
        />
        <Pagination
          hasPrev={page > 1}
          hasNext={!!list.data?.nextCursor}
          loading={list.isFetching}
          summary={`Página ${page}`}
          onPrev={() => setCursors((c) => c.slice(0, -1))}
          onNext={() => {
            const next = list.data?.nextCursor;
            if (next) setCursors((c) => [...c, next]);
          }}
        />
      </div>

      <Drawer open={detail !== null} title={detail ? `Registro ${detail.seq}` : ''} onClose={() => setDetail(null)} width="xl">
        {detail && <AuditDetail item={detail} />}
      </Drawer>

      <Modal open={check !== null} title="Verificação de integridade" size="sm" onClose={() => setCheck(null)} footer={<Button variant="primary" onClick={() => setCheck(null)}>Fechar</Button>}>
        {check && (
          <div className="pilha" style={{ gap: 'var(--e3)' }}>
            {check.intact ? <Badge tone="success">Cadeia íntegra</Badge> : <Badge tone="danger">Sequência quebrada</Badge>}
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 'var(--e1) var(--e4)' }}>
              <dt className="texto-suave">Registros verificados</dt><dd style={{ margin: 0 }}>{check.checked}</dd>
              {!check.intact && (<><dt className="texto-suave">Quebra na sequência</dt><dd style={{ margin: 0 }}>{check.brokenSeq}</dd></>)}
              <dt className="texto-suave">Última sequência</dt><dd style={{ margin: 0 }}>{check.headSeq ?? '—'}</dd>
              <dt className="texto-suave">Último hash</dt><dd style={{ margin: 0, wordBreak: 'break-all' }}><code>{check.headHash ?? '—'}</code></dd>
            </dl>
          </div>
        )}
      </Modal>
      {verify.isPending && <span className="sr-only" role="status"><Spinner label="Verificando" /></span>}
    </>
  );
}

function Json({ title, value }: { title: string; value: unknown }) {
  const empty = value === null || value === undefined || (typeof value === 'object' && Object.keys(value as object).length === 0);
  return (
    <section>
      <h3 style={{ marginBottom: 'var(--e2)' }}>{title}</h3>
      {empty ? (
        <p className="texto-suave">Sem dados.</p>
      ) : (
        <pre style={{ margin: 0, padding: 'var(--e3)', background: '#f4f6f8', borderRadius: 4, overflow: 'auto', fontSize: '0.85rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </section>
  );
}

function AuditDetail({ item }: { item: AuditItem }) {
  return (
    <div className="pilha">
      <p>{item.summary}</p>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 'var(--e1) var(--e4)' }}>
        <dt className="texto-suave">Data</dt><dd style={{ margin: 0 }}><DateText value={item.occurredAt} withTime /></dd>
        <dt className="texto-suave">Autor</dt><dd style={{ margin: 0 }}>{item.actorLabel ?? ACTOR_LABEL[item.actorType] ?? item.actorType}</dd>
        <dt className="texto-suave">Ação</dt><dd style={{ margin: 0 }}><code>{item.action}</code></dd>
        <dt className="texto-suave">Entidade</dt><dd style={{ margin: 0 }}>{item.entityType}{item.entityId ? ` · ${item.entityId}` : ''}</dd>
        {item.ip && (<><dt className="texto-suave">IP</dt><dd style={{ margin: 0 }}>{item.ip}</dd></>)}
        {item.requestId && (<><dt className="texto-suave">Requisição</dt><dd style={{ margin: 0 }}>{item.requestId}</dd></>)}
        <dt className="texto-suave">Hash</dt><dd style={{ margin: 0, wordBreak: 'break-all' }}><code>{item.hash}</code></dd>
      </dl>
      <div className="grade-2">
        <Json title="Antes" value={item.before} />
        <Json title="Depois" value={item.after} />
      </div>
      <Json title="Metadados" value={item.metadata} />
    </div>
  );
}
