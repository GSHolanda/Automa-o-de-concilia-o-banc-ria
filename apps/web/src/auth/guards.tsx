import type { ModuleKey, PermissionKey } from '@concilia/core/shared';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Spinner } from '../components/Spinner';
import { Button } from '../components/Button';
import { useAuth } from './AuthProvider';

/** Exige sessão; senha temporária obriga a troca; operador da plataforma só usa as rotas dele. */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { status, me, error, refresh } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="tela-cheia">
        <Spinner label="Carregando…" />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="tela-cheia">
        <EmptyState
          title="Não foi possível carregar a sessão"
          description={error ?? undefined}
          action={<Button onClick={() => void refresh()}>Tentar novamente</Button>}
        />
      </div>
    );
  }
  if (!me) return <Navigate to="/entrar" replace state={{ from: location.pathname + location.search }} />;
  if (me.user.mustChangePassword && location.pathname !== '/trocar-senha') {
    return <Navigate to="/trocar-senha" replace />;
  }
  return <>{children ?? <Outlet />}</>;
}

interface RequirePermissionProps {
  permission?: PermissionKey;
  anyOf?: PermissionKey[];
  module?: ModuleKey;
  /** Rota exclusiva do operador da plataforma. */
  platform?: boolean;
  children?: ReactNode;
}

export function RequirePermission({ permission, anyOf, module, platform, children }: RequirePermissionProps) {
  const { me, can, hasModule } = useAuth();
  const isPlatform = me?.isPlatformAdmin ?? false;
  let allowed = true;
  if (platform) allowed = isPlatform;
  else if (isPlatform) allowed = false;
  else {
    if (permission && !can(permission)) allowed = false;
    if (anyOf && !anyOf.some(can)) allowed = false;
    if (module && !hasModule(module)) allowed = false;
  }
  if (!allowed) {
    return (
      <EmptyState
        title="Acesso não permitido"
        description="Seu perfil não tem permissão para ver esta página."
      />
    );
  }
  return <>{children ?? <Outlet />}</>;
}
