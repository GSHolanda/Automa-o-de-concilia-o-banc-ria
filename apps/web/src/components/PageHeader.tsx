import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="pagina-topo">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="texto-suave">{subtitle}</p>}
      </div>
      {actions && <div className="linha">{actions}</div>}
    </div>
  );
}
