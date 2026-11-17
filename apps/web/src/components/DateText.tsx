import { formatDateBR } from '@concilia/core/shared';

/** Data civil AAAA-MM-DD (ou instante ISO) em DD/MM/AAAA. */
export function DateText({ value, withTime = false }: { value: string | null | undefined; withTime?: boolean }) {
  if (!value) return <span className="texto-suave">—</span>;
  if (withTime && value.length > 10) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return <time dateTime={value}>{d.toLocaleString('pt-BR')}</time>;
    }
  }
  return <time dateTime={value.slice(0, 10)}>{formatDateBR(value.slice(0, 10))}</time>;
}
