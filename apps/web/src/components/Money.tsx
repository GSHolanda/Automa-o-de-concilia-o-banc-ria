import { formatBRL } from '@concilia/core/shared';

/** Valor em centavos: algarismos tabulares, à direita, negativo em vermelho. */
export function Money({ cents, className }: { cents: number | null | undefined; className?: string }) {
  if (cents === null || cents === undefined) return <span className="num texto-suave">—</span>;
  return <span className={`num ${cents < 0 ? 'valor-negativo' : ''} ${className ?? ''}`.trim()}>{formatBRL(cents)}</span>;
}
