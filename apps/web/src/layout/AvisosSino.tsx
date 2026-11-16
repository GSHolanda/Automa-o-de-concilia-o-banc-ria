import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { Button } from '../components/Button';
import { DateText } from '../components/DateText';
import { useAuth } from '../auth';
import { useWrite } from '../features/shared';

interface Aviso {
  id: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}
interface Avisos {
  items: Aviso[];
  unreadCount: number;
}

const KEY = ['avisos'] as const;

/** Sino de avisos internos: contagem de não lidos, lista suspensa e marcação como lido (atualiza a cada 60 s). */
export function AvisosSino() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const queryClient = useQueryClient();
  const { status } = useAuth();
  // Consulta periódica só enquanto houver sessão autenticada; o sinal cancela a requisição ao sair.
  const q = useQuery({
    queryKey: KEY,
    enabled: status === 'authenticated',
    refetchInterval: status === 'authenticated' ? 60_000 : false,
    queryFn: ({ signal }) => api.get<Avisos>('/notifications', { limit: 20 }, signal),
  });
  const unread = q.data?.unreadCount ?? 0;

  const read = useWrite<string>({ invalidate: [KEY], mutationFn: (id) => api.post(`/notifications/${id}/read`) });
  const readAll = useWrite({ invalidate: [KEY], mutationFn: () => api.post('/notifications/read-all') });

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    void queryClient.invalidateQueries({ queryKey: KEY });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, queryClient]);

  return (
    <div className="usuario" ref={ref}>
      <button
        type="button"
        className="usuario-botao"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread > 0 ? `Avisos, ${unread} não lidos` : 'Avisos'}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <span className="badge badge-info" aria-hidden="true">{unread}</span>}
      </button>
      {open && (
        <div className="usuario-painel" role="region" aria-label="Lista de avisos" style={{ width: 'min(360px, calc(100vw - 32px))', maxHeight: '70vh', overflowY: 'auto' }}>
          <div className="linha" style={{ justifyContent: 'space-between', padding: 'var(--e2) var(--e3)' }}>
            <strong>Avisos</strong>
            <Button size="sm" variant="ghost" disabled={unread === 0} loading={readAll.isPending} onClick={() => readAll.mutate()}>Marcar todos como lidos</Button>
          </div>
          {q.isError && <p className="campo-erro" role="alert">{errorMessage(q.error)}</p>}
          {q.data && q.data.items.length === 0 && <p className="texto-suave" style={{ padding: 'var(--e3)' }}>Nenhum aviso.</p>}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {q.data?.items.map((a) => (
              <li key={a.id} style={{ padding: 'var(--e3)', borderTop: '1px solid var(--cor-borda)', fontWeight: a.readAt ? 400 : 600 }}>
                <div>{a.title}</div>
                <div className="texto-suave" style={{ fontWeight: 400 }}>{a.body}</div>
                <div className="linha" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                  <span className="texto-suave" style={{ fontWeight: 400 }}><DateText value={a.createdAt} withTime /></span>
                  <span className="linha">
                    {a.link && <Link to={a.link} onClick={() => !a.readAt && read.mutate(a.id)}>Abrir</Link>}
                    {!a.readAt && <Button size="sm" variant="ghost" onClick={() => read.mutate(a.id)}>Marcar como lido<span className="sr-only">: {a.title}</span></Button>}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
