import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { DateText } from '../../components/DateText';
import { PageHeader } from '../../components/PageHeader';
import { useToast } from '../../components/Toast';
import { PasswordForm } from '../auth/PasswordForm';

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export function MinhaContaPage() {
  const { me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<SessionRow | null>(null);

  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => api.get<{ items: SessionRow[] }>('/auth/sessions'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: async () => {
      toast.success('Sessão encerrada.');
      await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => setTarget(null),
  });

  const columns: Column<SessionRow>[] = [
    {
      key: 'device',
      header: 'Dispositivo',
      render: (s) => (
        <span>
          {s.userAgent ? s.userAgent.slice(0, 60) : 'Desconhecido'} {s.current && <Badge tone="success">Esta sessão</Badge>}
        </span>
      ),
    },
    { key: 'ip', header: 'Endereço IP', render: (s) => s.ip ?? '—', hideOnMobile: true },
    { key: 'lastSeenAt', header: 'Última atividade', render: (s) => <DateText value={s.lastSeenAt} withTime /> },
    { key: 'expiresAt', header: 'Expira em', render: (s) => <DateText value={s.expiresAt} withTime />, hideOnMobile: true },
    {
      key: 'actions',
      header: 'Ações',
      align: 'right',
      render: (s) =>
        s.current ? (
          <span className="texto-suave">—</span>
        ) : (
          <Button size="sm" variant="danger" onClick={() => setTarget(s)}>
            Encerrar<span className="sr-only"> sessão iniciada em {s.createdAt}</span>
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader title="Minha conta" />
      <div className="pilha">
        <section className="cartao" aria-labelledby="dados">
          <h2 id="dados" style={{ marginBottom: 'var(--e3)' }}>Dados</h2>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 'var(--e1) var(--e4)' }}>
            <dt className="texto-suave">Nome</dt><dd style={{ margin: 0 }}>{me?.user.name}</dd>
            <dt className="texto-suave">E-mail</dt><dd style={{ margin: 0 }}>{me?.user.email}</dd>
            {me?.role && (<><dt className="texto-suave">Papel</dt><dd style={{ margin: 0 }}>{me.role.name}</dd></>)}
            {me?.tenant && (<><dt className="texto-suave">Empresa</dt><dd style={{ margin: 0 }}>{me.tenant.tradeName}</dd></>)}
          </dl>
        </section>

        <section aria-labelledby="sessoes">
          <h2 id="sessoes" style={{ marginBottom: 'var(--e3)' }}>Sessões ativas</h2>
          <DataTable
            caption="Sessões ativas"
            columns={columns}
            rows={sessions.data?.items}
            rowKey={(s) => s.id}
            loading={sessions.isLoading}
            error={sessions.isError ? errorMessage(sessions.error) : null}
            onRetry={() => void sessions.refetch()}
            emptyTitle="Nenhuma sessão ativa"
          />
        </section>

        <section className="cartao" aria-labelledby="senha" style={{ maxWidth: 480 }}>
          <h2 id="senha" style={{ marginBottom: 'var(--e3)' }}>Trocar senha</h2>
          <p className="texto-suave" style={{ marginBottom: 'var(--e3)' }}>
            Ao trocar a senha, suas outras sessões são encerradas.
          </p>
          <PasswordForm
            onDone={async () => {
              toast.success('Senha alterada. As outras sessões foram encerradas.');
              await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
            }}
          />
        </section>
      </div>

      <ConfirmDialog
        open={target !== null}
        title="Encerrar sessão"
        message="O dispositivo será desconectado e precisará entrar novamente."
        confirmLabel="Encerrar sessão"
        destructive
        onCancel={() => setTarget(null)}
        onConfirm={async () => {
          if (target) await revoke.mutateAsync(target.id).catch(() => undefined);
        }}
      />
    </>
  );
}
