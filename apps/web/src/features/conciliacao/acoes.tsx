import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { Money } from '../../components/Money';
import { Select } from '../../components/Select';
import { useToast } from '../../components/Toast';
import { useWrite } from '../shared';
import { isConflict, useOptions } from './comum';
import { RECON_KEY, type ReconItem } from './tipos';

export const PENDING_MSG = 'Decisão registrada: aguarda aprovação de outra pessoa.';
const REFRESH_MSG = 'Os itens já foram conciliados por outra decisão. A lista foi recarregada.';
const INVALIDATE = [[...RECON_KEY], ['dashboard']];

type Decision = { status?: string };
type Dialog =
  | { kind: 'reject'; id: string }
  | { kind: 'ignore'; item: ReconItem }
  | { kind: 'undo'; id: string; label: string }
  | { kind: 'classify'; item: ReconItem };

/** Trata o erro 409 já conciliado: recarrega as listas e avisa. Devolve true se tratou. */
export function useConflict() {
  const toast = useToast();
  const queryClient = useQueryClient();
  return (error: unknown): boolean => {
    if (!isConflict(error)) return false;
    toast.info(REFRESH_MSG);
    void queryClient.invalidateQueries({ queryKey: RECON_KEY });
    return true;
  };
}

export const doneMessage = (ok: string) => (r: Decision) => (r.status === 'pending_approval' ? PENDING_MSG : ok);

/** Ações de decisão por item/sugestão, com os diálogos de justificativa. */
export function useAcoes() {
  const toast = useToast();
  const conflict = useConflict();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);

  const accept = useWrite<string, Decision>({
    mutationFn: (id) => api.post(`/reconciliation/matches/${id}/accept`, {}),
    invalidate: INVALIDATE,
    inlineError: true,
    success: doneMessage('Sugestão aceita.'),
  });
  const reject = useWrite<{ id: string; reason: string }, Decision>({
    mutationFn: ({ id, reason }) => api.post(`/reconciliation/matches/${id}/reject`, { reason }),
    invalidate: INVALIDATE,
    inlineError: true,
    success: 'Sugestão rejeitada.',
    onSuccess: close,
  });
  const ignore = useWrite<{ item: ReconItem; reason: string }, Decision>({
    mutationFn: ({ item, reason }) => api.post('/reconciliation/items/ignore', { side: item.side, id: item.id, reason }),
    invalidate: INVALIDATE,
    inlineError: true,
    success: doneMessage('Item ignorado.'),
    onSuccess: close,
  });
  const undo = useWrite<{ id: string; reason: string }, Decision>({
    mutationFn: ({ id, reason }) => api.post(`/reconciliation/matches/${id}/undo`, { reason }),
    invalidate: INVALIDATE,
    inlineError: true,
    success: doneMessage('Conciliação desfeita.'),
    onSuccess: close,
  });
  const classify = useWrite<{ item: ReconItem; categoryId: string; note: string }, Decision>({
    mutationFn: ({ item, categoryId, note }) =>
      api.post('/reconciliation/items/classify', { bankTransactionId: item.id, categoryId, note: note.trim() || undefined }),
    invalidate: INVALIDATE,
    inlineError: true,
    success: doneMessage('Transação classificada.'),
    onSuccess: close,
  });

  const fail = (e: unknown) => {
    if (conflict(e)) close();
    else if (e instanceof Error) toast.error(e.message);
  };

  const dialogs: ReactNode = (
    <>
      <ReasonModal
        open={dialog?.kind === 'reject'}
        title="Rejeitar sugestão"
        description="O par não será proposto novamente."
        confirmLabel="Rejeitar"
        destructive
        busy={reject.isPending}
        error={reject.errorText}
        onClose={close}
        onConfirm={(reason) => dialog?.kind === 'reject' && reject.mutate({ id: dialog.id, reason }, { onError: fail })}
      />
      <ReasonModal
        open={dialog?.kind === 'ignore'}
        title="Ignorar item"
        description={dialog?.kind === 'ignore' ? `${dialog.item.description} — o item sai da fila de pendências.` : undefined}
        confirmLabel="Ignorar"
        busy={ignore.isPending}
        error={ignore.errorText}
        onClose={close}
        onConfirm={(reason) => dialog?.kind === 'ignore' && ignore.mutate({ item: dialog.item, reason }, { onError: fail })}
      />
      <ReasonModal
        open={dialog?.kind === 'undo'}
        title="Desfazer conciliação"
        description={dialog?.kind === 'undo' ? `${dialog.label} voltará para pendente.` : undefined}
        confirmLabel="Desfazer"
        destructive
        busy={undo.isPending}
        error={undo.errorText}
        onClose={close}
        onConfirm={(reason) => dialog?.kind === 'undo' && undo.mutate({ id: dialog.id, reason }, { onError: fail })}
      />
      {dialog?.kind === 'classify' && (
        <ClassifyModal
          item={dialog.item}
          busy={classify.isPending}
          error={classify.errorText}
          onClose={close}
          onConfirm={(categoryId, note) => classify.mutate({ item: dialog.item, categoryId, note }, { onError: fail })}
        />
      )}
    </>
  );

  return {
    dialogs,
    accepting: accept.isPending ? (accept.variables ?? null) : null,
    accept: (id: string) => accept.mutate(id, { onError: fail }),
    reject: (id: string) => { reject.reset(); setDialog({ kind: 'reject', id }); },
    ignore: (item: ReconItem) => { ignore.reset(); setDialog({ kind: 'ignore', item }); },
    undo: (id: string, label: string) => { undo.reset(); setDialog({ kind: 'undo', id, label }); },
    classify: (item: ReconItem) => { classify.reset(); setDialog({ kind: 'classify', item }); },
  };
}
export type Acoes = ReturnType<typeof useAcoes>;

interface ReasonProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  destructive?: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}

/** Diálogo com justificativa obrigatória. */
function ReasonModal({ open, title, description, confirmLabel, destructive, busy, error, onClose, onConfirm }: ReasonProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const empty = reason.trim() === '';
  useEffect(() => {
    if (!open) { setReason(''); setTouched(false); }
  }, [open]);
  const handleClose = onClose;
  return (
    <Modal
      open={open}
      title={title}
      onClose={handleClose}
      size="sm"
      footer={
        <>
          <Button onClick={handleClose}>Cancelar</Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            loading={busy}
            onClick={() => {
              setTouched(true);
              if (!empty) onConfirm(reason.trim());
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="pilha">
        {description && <p>{description}</p>}
        <Field
          label="Motivo"
          multiline
          rows={3}
          maxLength={1000}
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={touched && empty ? 'Informe o motivo.' : null}
        />
        {error && <p className="campo-erro" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

function ClassifyModal({ item, busy, error, onClose, onConfirm }: {
  item: ReconItem; busy: boolean; error: string | null; onClose: () => void; onConfirm: (categoryId: string, note: string) => void;
}) {
  const categories = useOptions('/categories');
  const [categoryId, setCategoryId] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  return (
    <Modal
      open
      title="Classificar transação"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              setTouched(true);
              if (categoryId) onConfirm(categoryId, note);
            }}
          >
            Classificar
          </Button>
        </>
      }
    >
      <div className="pilha">
        <p>{item.description} · <Money cents={item.amountCents} /></p>
        <Select
          label="Categoria"
          required
          placeholder={categories.isLoading ? 'Carregando…' : 'Selecione'}
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          options={(categories.data?.items ?? []).filter((c) => c.active !== false).map((c) => ({ value: c.id, label: c.name }))}
          error={categories.isError ? 'Não foi possível carregar as categorias.' : touched && !categoryId ? 'Escolha uma categoria.' : null}
        />
        <Field label="Observação" multiline rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        {error && <p className="campo-erro" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
