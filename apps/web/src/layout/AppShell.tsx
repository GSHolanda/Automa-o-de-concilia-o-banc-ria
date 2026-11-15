import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { APP_ROUTES } from '../routes';

interface MenuEntry {
  to: string;
  label: string;
  end?: boolean;
}

function useMenu(): MenuEntry[] {
  const { me, can, hasModule } = useAuth();
  if (!me) return [];
  const entries: MenuEntry[] = [];
  if (me.isPlatformAdmin) {
    entries.push({ to: '/plataforma/empresas', label: 'Empresas' });
    return entries;
  }
  for (const r of APP_ROUTES) {
    if (!r.menu || r.platform) continue;
    if (r.permission && !can(r.permission)) continue;
    if (r.module && !hasModule(r.module)) continue;
    entries.push({ to: r.path, label: r.title, end: r.path === '/' });
    // "Configurações" fica logo antes de "Implantação".
    if (r.path === '/auditoria' && can('settings.view')) entries.push({ to: '/configuracoes', label: 'Configurações' });
  }
  return entries;
}

export function AppShell() {
  const { me, logout, readOnly } = useAuth();
  const menu = useMenu();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMenuOpen(false);
    setUserOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen && !userOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setUserOpen(false);
      }
    }
    function onClick(e: MouseEvent) {
      if (userOpen && userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen, userOpen]);

  if (!me) return null;
  const logo = me.branding?.logoDataUrl;
  const companyName = me.tenant?.tradeName ?? me.productName;

  return (
    <div className="app">
      <div className={menuOpen ? 'menu-fundo aberto' : 'menu-fundo'} onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <nav id="menu-principal" className={menuOpen ? 'menu aberto' : 'menu'} aria-label="Menu principal">
        <div className="menu-marca">
          {logo ? <img src={logo} alt={`Logotipo de ${companyName}`} /> : <span>{me.productName}</span>}
        </div>
        <ul className="menu-lista">
          {menu.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'menu-item ativo' : 'menu-item')}>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="menu-rodape">
          <NavLink to="/minha-conta" className={({ isActive }) => (isActive ? 'menu-item ativo' : 'menu-item')}>
            Minha conta
          </NavLink>
        </div>
      </nav>

      <div className="app-principal">
        <header className="barra">
          <button
            ref={toggleRef}
            type="button"
            className="icone-btn barra-hamburguer"
            aria-label="Abrir menu"
            aria-expanded={menuOpen}
            aria-controls="menu-principal"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <div className="barra-empresa">{me.isPlatformAdmin ? `${me.productName} · Plataforma` : companyName}</div>
          <div className="usuario" ref={userRef}>
            <button
              type="button"
              className="usuario-botao"
              aria-haspopup="menu"
              aria-expanded={userOpen}
              onClick={() => setUserOpen((v) => !v)}
            >
              <span className="usuario-nome">{me.user.name}</span>
              <span aria-hidden="true">▾</span>
            </button>
            {userOpen && (
              <div className="usuario-painel" role="menu">
                <div className="usuario-info">
                  <strong>{me.user.name}</strong>
                  <div className="texto-suave">{me.user.email}</div>
                  {me.role && <div className="texto-suave">{me.role.name}</div>}
                </div>
                <Link to="/minha-conta" role="menuitem" className="menu-item">Minha conta</Link>
                <button type="button" role="menuitem" className="menu-item" onClick={() => void logout()}>Sair</button>
              </div>
            )}
          </div>
        </header>
        {readOnly && (
          <div className="faixa-aviso" role="status">
            Licença em somente leitura
            {me.license?.readOnlyReason ? `: ${me.license.readOnlyReason}` : ''}. Alterações estão desabilitadas.
          </div>
        )}
        <main className="conteudo" id="conteudo">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
