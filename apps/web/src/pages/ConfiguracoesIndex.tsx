import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { PageHeader } from '../components/PageHeader';
import { SETTINGS_ROUTES } from '../routes';

/** Índice de /configuracoes: links apenas para o que o usuário pode abrir. */
export function ConfiguracoesIndex() {
  const { can, hasModule } = useAuth();
  const items = SETTINGS_ROUTES.filter((r) => (!r.permission || can(r.permission)) && (!r.module || hasModule(r.module)));
  return (
    <>
      <PageHeader title="Configurações" />
      <ul className="grade-2" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {items.map((r) => (
          <li key={r.path}>
            <Link to={r.path} className="cartao" style={{ display: 'block', textDecoration: 'none', color: 'inherit', fontWeight: 600 }}>
              {r.title}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
