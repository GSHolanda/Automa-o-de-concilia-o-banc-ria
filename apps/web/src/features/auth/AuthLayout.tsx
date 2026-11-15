import type { ReactNode } from 'react';
import { useAuth } from '../../auth';

/** Moldura das telas sem menu (entrar, trocar senha). */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  const { me } = useAuth();
  const logo = me?.branding?.logoDataUrl;
  return (
    <div className="tela-cheia">
      <div className="auth-cartao cartao">
        <div className="auth-marca">
          {logo ? <img src={logo} alt="Logotipo da empresa" /> : <strong>{me?.productName ?? 'Concilia'}</strong>}
        </div>
        <h1 style={{ marginBottom: 'var(--e4)' }}>{title}</h1>
        {children}
      </div>
    </div>
  );
}
