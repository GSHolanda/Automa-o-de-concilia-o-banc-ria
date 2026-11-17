import { Badge, type BadgeTone } from './Badge';

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  matched: { label: 'Conciliado', tone: 'success' },
  reconciled: { label: 'Conciliado', tone: 'success' },
  pending: { label: 'Pendente', tone: 'warning' },
  unmatched: { label: 'Pendente', tone: 'warning' },
  suggested: { label: 'Sugestão', tone: 'warning' },
  divergent: { label: 'Divergente', tone: 'danger' },
  ignored: { label: 'Ignorado', tone: 'neutral' },
  pending_approval: { label: 'Aguardando aprovação', tone: 'info' },
  rejected: { label: 'Recusado', tone: 'danger' },
  active: { label: 'Ativo', tone: 'success' },
  disabled: { label: 'Inativo', tone: 'neutral' },
  succeeded: { label: 'Concluído', tone: 'success' },
  running: { label: 'Em andamento', tone: 'info' },
  queued: { label: 'Na fila', tone: 'neutral' },
  failed: { label: 'Falhou', tone: 'danger' },
  dead: { label: 'Falhou', tone: 'danger' },
};

/** Situação com cor e texto (a cor nunca é o único indicador). Aceita `label` para sobrescrever o texto. */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const entry = STATUS[status] ?? { label: status, tone: 'neutral' as BadgeTone };
  return <Badge tone={entry.tone}>{label ?? entry.label}</Badge>;
}
