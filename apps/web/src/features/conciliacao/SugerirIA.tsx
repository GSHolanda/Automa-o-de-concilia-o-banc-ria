import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Money } from '../../components/Money';
import { useWrite } from '../shared';
import { useOptions } from './comum';
import { RECON_KEY, type ReconItem } from './tipos';

type Resultado =
  | { bankTransactionId: string; status: 'suggested'; matchId: string; categoryId: string; confidence: number; rationale: string }
  | { bankTransactionId: string; status: 'no_suggestion'; rationale: string }
  | { bankTransactionId: string; status: 'skipped'; reason: string };

/** Pede sugestões de categoria por IA para transações pendentes do extrato. Nada é confirmado aqui. */
export function SugerirIAModal({ items, onClose }: { items: ReconItem[]; onClose: () => void }) {
  const categories = useOptions('/categories');
  const [results, setResults] = useState<Resultado[] | null>(null);
  const run = useWrite<void, { items: Resultado[] }>({
    inlineError: true,
    invalidate: [[...RECON_KEY], ['dashboard']],
    mutationFn: () => api.post('/ai/suggest-categories', { bankTransactionIds: items.map((i) => i.id) }),
    onSuccess: (r) => setResults(r.items),
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const catName = (id: string) => categories.data?.items.find((c) => c.id === id)?.name ?? 'Categoria';
  const notConfigured = run.error instanceof ApiError && run.error.status === 409 && run.error.code === 'integration_not_configured';
  const suggested = results?.filter((r) => r.status === 'suggested').length ?? 0;

  return (
    <Modal
      open
      size="lg"
      title="Sugerir categorias por IA"
      onClose={onClose}
      footer={
        results ? (
          <Button variant="primary" onClick={onClose}>Fechar</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="primary" loading={run.isPending} onClick={() => run.mutate()}>Pedir sugestões</Button>
          </>
        )
      }
    >
      <div className="pilha">
        <p>
          As categorias abaixo são <strong>sugestões a revisar</strong>: nada é confirmado automaticamente. Cada sugestão aparece na aba Sugestões e só vale depois do seu aceite.
          Ao provedor de IA são enviados apenas a descrição normalizada, o sinal e o tipo de cada transação.
        </p>
        {!results && <p>{items.length} transação(ões) pendente(s) do extrato selecionada(s).</p>}
        {run.errorText && !notConfigured && <p className="campo-erro" role="alert">{run.errorText}</p>}
        {notConfigured && (
          <p className="campo-erro" role="alert">
            {run.errorText} <Link to="/configuracoes/integracoes">Abrir Integrações</Link>
          </p>
        )}
        {results && (
          <>
            <p aria-live="polite"><strong>{suggested}</strong> sugestão(ões) gerada(s). Revise na aba <Link to="/conciliacao?aba=sugestoes" onClick={onClose}>Sugestões</Link>.</p>
            <ul className="pilha" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Resultado por item">
              {results.map((r) => {
                const item = byId.get(r.bankTransactionId);
                return (
                  <li key={r.bankTransactionId} className="cartao pilha">
                    <div className="linha" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                      <span>{item?.description ?? r.bankTransactionId} {item && <Money cents={item.amountCents} />}</span>
                      {r.status === 'suggested' && <Badge tone="info">Sugestão: {catName(r.categoryId)} ({Math.round(r.confidence * 100)}%)</Badge>}
                      {r.status === 'no_suggestion' && <Badge>Sem sugestão</Badge>}
                      {r.status === 'skipped' && <Badge tone="warning">Ignorada</Badge>}
                    </div>
                    <span className="texto-suave">{r.status === 'skipped' ? r.reason : r.rationale}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
