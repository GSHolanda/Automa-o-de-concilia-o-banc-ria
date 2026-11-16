import { ApiError, errorMessage } from '../../api/client';
import { Badge, type BadgeTone } from '../../components/Badge';

/** Mensagem da API com os detalhes de validação (campo: mensagem), quando existirem. */
export function detailedError(error: unknown): string {
  const base = errorMessage(error);
  if (error instanceof ApiError && Array.isArray(error.details)) {
    const lines = (error.details as { path?: string; message?: string }[])
      .filter((d) => d && d.message)
      .map((d) => (d.path ? `${d.path}: ${d.message}` : String(d.message)));
    if (lines.length > 0) return `${base} ${lines.join('; ')}`;
  }
  return base;
}

export const INTEGRATION_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  not_configured: { label: 'Não configurada', tone: 'neutral' },
  configured: { label: 'Configurada (não testada)', tone: 'info' },
  verified: { label: 'Verificada', tone: 'success' },
  error: { label: 'Com erro', tone: 'danger' },
};

/** Situação da integração com rótulo e cor (a cor nunca é o único indicador). */
export function IntegrationStatusBadge({ status }: { status: string }) {
  const entry = INTEGRATION_STATUS[status] ?? { label: status, tone: 'neutral' as BadgeTone };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}
