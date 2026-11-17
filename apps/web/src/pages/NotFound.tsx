import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';

export function NotFound() {
  return <EmptyState title="Página não encontrada" action={<Link to="/">Voltar ao início</Link>} />;
}
