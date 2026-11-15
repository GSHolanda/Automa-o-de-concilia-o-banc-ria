import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';

/** Página provisória: cada tela de negócio substitui este componente em src/routes.tsx. */
export function EmConstrucao({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title="Em construção" description="Esta tela ainda não está disponível." />
    </>
  );
}
