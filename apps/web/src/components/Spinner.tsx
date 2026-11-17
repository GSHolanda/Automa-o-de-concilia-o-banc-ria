export function Spinner({ label = 'Carregando…', inline = false }: { label?: string; inline?: boolean }) {
  return (
    <span className={inline ? 'spinner-wrap spinner-inline' : 'spinner-wrap'} role="status">
      <span className="spinner" aria-hidden="true" />
      <span className={inline ? 'sr-only' : undefined}>{label}</span>
    </span>
  );
}
