import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, errorMessage, type Page } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { DateText } from '../../components/DateText';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { Money } from '../../components/Money';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useWrite } from '../shared';

interface MatchItem { side: 'bank' | 'ledger'; id: string; date: string; amountCents: number; description: string }
interface PendingMatch {
  id: string;
  type: string;
  bankAccountName: string | null;
  proposedByName: string | null;
  proposedAt: string | null;
  proposalNote: string | null;
  differenceCents: number;
  divergence: string | null;
  bank: MatchItem[];
  ledger: MatchItem[];
  totals: { bankCents: number; ledgerCents: number };
}

const TYPE_LABEL: Record<string, string> = {
  manual: 'Manual',
  ignored: 'Ignorado',
  exact: 'Exato',
  one_to_one: 'Um para um',
  one_to_many: 'Um para vários',
  many_to_one: 'Vários para um',
  many_to_many: 'Vários para vários',
};
const PAGE_SIZE = 20;
export const APPROVALS_KEY = ['approvals'];

function Items({ title, items, total }: { title: string; items: MatchItem[]; total: number }) {
  return (
    <div>
      <h4>{title} · <Money cents={total} /></h4>
      {items.length === 0 ? (
        <p className="texto-suave">Nenhum item.</p>
      ) : (
        <ul className="pilha" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 'var(--e1)' }}>
          {items.map((i) => (
            <li key={i.id} className="linha" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><DateText value={i.date} /> · {i.description}</span>
              <Money cents={i.amountCents} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Action = { kind: 'approve' | 'refuse'; match: PendingMatch };

export function AprovacoesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const [action, setAction] = useState<Action | null>(null);
  const [text, setText] = useState('');
  const [fourEyes, setFourEyes] = useState(false);

  const list = useQuery({
    queryKey: [...APPROVALS_KEY, cursor],
    queryFn: () => api.get<Page<PendingMatch>>('/reconciliation/matches', { status: 'pending_approval', limit: PAGE_SIZE, cursor }),
  });

  function close() {
    setAction(null);
    setText('');
    setFourEyes(false);
  }

  const decide = useWrite<Action, unknown>({
    inlineError: true,
    invalidate: [APPROVALS_KEY, ['dashboard'], ['approvals-count'], ['reconciliation']],
    mutationFn: ({ kind, match }) =>
      kind === 'approve'
        ? api.post(`/reconciliation/matches/${match.id}/approve`, { note: text.trim() })
        : api.post(`/reconciliation/matches/${match.id}/refuse`, { reason: text.trim() }),
    success: (_r, v) => (v.kind === 'approve' ? 'Conciliação aprovada.' : 'Conciliação recusada.'),
    onSuccess: close,
  });

  function submit() {
    if (!action) return;
    if (action.kind === 'refuse' && !text.trim()) return;
    setFourEyes(false);
    decide.mutate(action, {
      onError: (error) => {
        if (error instanceof ApiError && error.status === 403 && error.code === 'four_eyes') setFourEyes(true);
        else toast.error(errorMessage(error));
      },
    });
  }

  const items = list.data?.items ?? [];
  const refuse = action?.kind === 'refuse';

  return (
    <div className="pilha">
      <PageHeader title="Aprovações" subtitle="Conciliações aguardando a decisão de um segundo usuário." />
      {list.isLoading && <div role="status" className="linha"><Spinner /> Carregando aprovações…</div>}
      {list.isError && (
        <EmptyState tone="error" title="Não foi possível carregar as aprovações" description={errorMessage(list.error)} action={<Button onClick={() => void list.refetch()}>Tentar de novo</Button>} />
      )}
      {list.data && items.length === 0 && (
        <EmptyState title="Nenhuma aprovação pendente" description="Quando uma conciliação exigir aprovação, ela aparece aqui." />
      )}
      {items.map((m) => (
        <article key={m.id} className="cartao pilha" aria-label={`Conciliação proposta por ${m.proposedByName ?? 'usuário'}`}>
          <div className="linha" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{m.proposedByName ?? 'Usuário removido'}</strong>{' '}
              <span className="texto-suave">propôs em <DateText value={m.proposedAt} withTime /></span>
            </div>
            <div className="linha">
              <Badge tone="info">{TYPE_LABEL[m.type] ?? m.type}</Badge>
              {m.bankAccountName && <Badge tone="neutral">{m.bankAccountName}</Badge>}
            </div>
          </div>
          {m.proposalNote && <p>Nota: {m.proposalNote}</p>}
          {m.divergence && <p className="erro-texto">Divergência: {m.divergence}</p>}
          <div className="painel-lados" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--e4)' }}>
            <Items title="Extrato" items={m.bank} total={m.totals.bankCents} />
            <Items title="Lançamentos" items={m.ledger} total={m.totals.ledgerCents} />
          </div>
          <div className="linha" style={{ justifyContent: 'space-between' }}>
            <span>Diferença: <Money cents={m.differenceCents} /></span>
            {can('reconciliation.approve') && (
              <div className="linha">
                <Button variant="primary" onClick={() => { setText(''); setFourEyes(false); decide.reset(); setAction({ kind: 'approve', match: m }); }}>Aprovar</Button>
                <Button variant="danger" onClick={() => { setText(''); setFourEyes(false); decide.reset(); setAction({ kind: 'refuse', match: m }); }}>Recusar</Button>
              </div>
            )}
          </div>
        </article>
      ))}
      {list.data && (cursors.length > 1 || list.data.nextCursor) && (
        <Pagination
          hasPrev={cursors.length > 1}
          hasNext={Boolean(list.data.nextCursor)}
          onPrev={() => setCursors((c) => c.slice(0, -1))}
          onNext={() => setCursors((c) => [...c, list.data?.nextCursor ?? undefined])}
          summary={`${items.length} nesta página`}
          loading={list.isFetching}
        />
      )}

      <Modal
        open={action !== null}
        title={refuse ? 'Recusar conciliação' : 'Aprovar conciliação'}
        onClose={close}
        footer={
          <>
            <Button onClick={close}>Cancelar</Button>
            <Button variant={refuse ? 'danger' : 'primary'} loading={decide.isPending} disabled={refuse && !text.trim()} onClick={submit}>
              {refuse ? 'Recusar' : 'Aprovar'}
            </Button>
          </>
        }
      >
        <div className="pilha">
          {fourEyes && (
            <p role="alert" className="erro-texto">
              Quem propôs a conciliação não pode aprová-la nem recusá-la. Peça a outro usuário com permissão de aprovação.
            </p>
          )}
          {!fourEyes && decide.errorText && <p role="alert" className="erro-texto">{decide.errorText}</p>}
          <Field
            label={refuse ? 'Motivo da recusa' : 'Nota (opcional)'}
            multiline
            required={refuse}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
}
