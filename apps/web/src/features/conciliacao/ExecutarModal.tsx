import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/Spinner';
import { useWrite } from '../shared';
import { useOptions } from './comum';
import { RECON_KEY, type Run } from './tipos';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ExecutarModal({ open, onClose, initial }: {
  open: boolean; onClose: () => void; initial: { bankAccountId: string; dateFrom: string; dateTo: string };
}) {
  const accounts = useOptions('/bank-accounts');
  const [bankAccountId, setBankAccountId] = useState(initial.bankAccountId);
  const [periodStart, setPeriodStart] = useState(initial.dateFrom || `${today().slice(0, 8)}01`);
  const [periodEnd, setPeriodEnd] = useState(initial.dateTo || today());
  const [runId, setRunId] = useState<string | null>(null);

  const start = useWrite<void, { runId: string }>({
    mutationFn: () => api.post('/reconciliation/runs', { bankAccountId, periodStart, periodEnd }),
    invalidate: [],
    inlineError: true,
    onSuccess: (r) => setRunId(r.runId),
  });

  const run = useQuery({
    queryKey: [...RECON_KEY, 'run', runId],
    enabled: runId !== null,
    queryFn: ({ signal }) => api.get<Run>(`/reconciliation/runs/${runId}`, undefined, signal),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'completed' || q.state.data.status === 'failed') ? false : 2000),
  });
  const status = run.data?.status;
  const finished = status === 'completed' || status === 'failed';

  const invalid = !bankAccountId || !periodStart || !periodEnd || periodEnd < periodStart;
  const close = () => { setRunId(null); start.reset(); onClose(); };

  return (
    <Modal
      open={open}
      title="Executar conciliação"
      onClose={close}
      size="sm"
      footer={
        runId ? (
          <Button variant="primary" onClick={close}>{finished ? 'Fechar' : 'Fechar e acompanhar depois'}</Button>
        ) : (
          <>
            <Button onClick={close}>Cancelar</Button>
            <Button variant="primary" disabled={invalid} loading={start.isPending} onClick={() => start.mutate()}>Executar</Button>
          </>
        )
      }
    >
      {!runId ? (
        <div className="pilha">
          <Select
            label="Conta bancária"
            required
            placeholder="Selecione"
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
            options={(accounts.data?.items ?? []).filter((a) => a.active !== false).map((a) => ({ value: a.id, label: a.name }))}
          />
          <div className="conc-duas">
            <Field label="Início do período" type="date" required value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            <Field
              label="Fim do período"
              type="date"
              required
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              error={periodEnd && periodEnd < periodStart ? 'O fim deve ser igual ou posterior ao início.' : null}
            />
          </div>
          <p className="campo-dica">O período pode ter no máximo 366 dias.</p>
          {start.errorText && <p className="campo-erro" role="alert">{start.errorText}</p>}
        </div>
      ) : (
        <div className="pilha" aria-live="polite">
          {run.isError && <p className="campo-erro" role="alert">{errorMessage(run.error)}</p>}
          {!finished && !run.isError && (
            <p className="linha"><Spinner inline label="Aguarde" /> {status === 'running' ? 'Conciliando…' : 'Na fila, aguardando execução…'}</p>
          )}
          {status === 'failed' && <p className="campo-erro" role="alert">A execução falhou. {run.data?.error ?? ''}</p>}
          {status === 'completed' && (
            <>
              <p><strong>Conciliação concluída.</strong></p>
              <dl className="conc-resumo">
                <div><dt>Conciliados automaticamente</dt><dd>{run.data?.stats.autoMatched ?? 0}</dd></div>
                <div><dt>Sugestões para revisar</dt><dd>{run.data?.stats.suggested ?? 0}</dd></div>
                <div><dt>Divergências</dt><dd>{run.data?.stats.divergences ?? 0}</dd></div>
              </dl>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
