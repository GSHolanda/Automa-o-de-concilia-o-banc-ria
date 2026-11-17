import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  action,
  tone = 'neutral',
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: 'neutral' | 'error';
}) {
  return (
    <div className={`vazio vazio-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <h3>{title}</h3>
      {description && <p className="texto-suave">{description}</p>}
      {action && <div className="vazio-acao">{action}</div>}
    </div>
  );
}
