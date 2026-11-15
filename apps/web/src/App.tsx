import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth, RequirePermission, useAuth } from './auth';
import { ChangePasswordPage } from './features/auth/ChangePasswordPage';
import { LoginPage } from './features/auth/LoginPage';
import { MinhaContaPage } from './features/conta/MinhaContaPage';
import { AppShell } from './layout/AppShell';
import { EmConstrucao } from './pages/EmConstrucao';
import { ConfiguracoesIndex } from './pages/ConfiguracoesIndex';
import { NotFound } from './pages/NotFound';
import { APP_ROUTES, SETTINGS_ROUTES, type AppRoute } from './routes';

function guarded(r: AppRoute) {
  return (
    <Route
      key={r.path}
      path={r.path}
      element={
        <RequirePermission permission={r.permission} module={r.module} platform={r.platform}>
          {r.element}
        </RequirePermission>
      }
    />
  );
}

function Home() {
  const { me } = useAuth();
  if (me?.isPlatformAdmin) return <Navigate to="/plataforma/empresas" replace />;
  const home = APP_ROUTES.find((r) => r.path === '/');
  return (
    <RequirePermission permission="dashboard.view">{home?.element ?? <EmConstrucao title="Painel" />}</RequirePermission>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/entrar" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/trocar-senha" element={<ChangePasswordPage />} />
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
          {APP_ROUTES.filter((r) => r.path !== '/').map(guarded)}
          <Route
            path="/configuracoes"
            element={
              <RequirePermission permission="settings.view">
                <ConfiguracoesIndex />
              </RequirePermission>
            }
          />
          {SETTINGS_ROUTES.map(guarded)}
          <Route path="/minha-conta" element={<MinhaContaPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
