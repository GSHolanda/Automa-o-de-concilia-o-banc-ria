import { Button } from './Button';

export interface PaginationProps {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** Texto central, ex.: "Página 2" ou "1–50 de 120". */
  summary?: string;
  loading?: boolean;
}

/** Paginação por cursor (a API devolve `nextCursor`; o chamador guarda a pilha de cursores). */
export function Pagination({ hasPrev, hasNext, onPrev, onNext, summary, loading }: PaginationProps) {
  return (
    <nav className="paginacao" aria-label="Paginação">
      <Button size="sm" onClick={onPrev} disabled={!hasPrev || loading}>Anterior</Button>
      {summary && <span className="texto-suave" aria-live="polite">{summary}</span>}
      <Button size="sm" onClick={onNext} disabled={!hasNext || loading}>Próxima</Button>
    </nav>
  );
}
