import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { DateText } from '../../components/DateText';
import { Field } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { Select } from '../../components/Select';
import { FormModal, SecretModal, useWrite } from '../shared';

interface UserItem {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'disabled';
  roleId: string;
  roleName: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
}
interface RoleItem { id: string; name: string }

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: UserItem }
  | { kind: 'reset'; user: UserItem }
  | { kind: 'revoke'; user: UserItem }
  | null;

export function UsuariosPage() {
  const { readOnly } = useAuth();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);

  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ items: UserItem[] }>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ items: RoleItem[] }>('/roles') });
  const close = () => setDialog(null);

  const reset = useWrite({
    mutationFn: (u: UserItem) => api.post<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`),
    invalidate: [['users']],
    onSuccess: (r, u) => {
      close();
      setSecret({ title: `Nova senha de ${u.name}`, value: r.temporaryPassword });
    },
  });
  const revoke = useWrite({
    mutationFn: (u: UserItem) => api.post(`/users/${u.id}/revoke-sessions`),
    invalidate: [['users']],
    success: 'Sessões encerradas.',
    onSuccess: close,
  });

  const columns: Column<UserItem>[] = [
    { key: 'name', header: 'Nome', render: (u) => <strong>{u.name}</strong> },
    { key: 'email', header: 'E-mail', render: (u) => u.email, hideOnMobile: true },
    { key: 'role', header: 'Papel', render: (u) => u.roleName },
    {
      key: 'status',
      header: 'Situação',
      render: (u) => (
        <span className="linha" style={{ gap: 'var(--e1)' }}>
          <Badge tone={u.status === 'active' ? 'success' : 'neutral'}>{u.status === 'active' ? 'Ativo' : 'Inativo'}</Badge>
          {u.lockedUntil && <Badge tone="danger">Bloqueado</Badge>}
          {u.mustChangePassword && <Badge tone="warning">Senha temporária</Badge>}
        </span>
      ),
    },
    { key: 'last', header: 'Último acesso', render: (u) => (u.lastLoginAt ? <DateText value={u.lastLoginAt} withTime /> : 'Nunca'), hideOnMobile: true },
    {
      key: 'actions',
      header: 'Ações',
      align: 'right',
      render: (u) => (
        <span className="linha" style={{ justifyContent: 'flex-end', gap: 'var(--e1)' }}>
          <Button size="sm" disabled={readOnly} onClick={() => setDialog({ kind: 'edit', user: u })}>
            Editar<span className="sr-only"> {u.name}</span>
          </Button>
          <Button size="sm" disabled={readOnly} onClick={() => setDialog({ kind: 'reset', user: u })}>
            Redefinir senha<span className="sr-only"> de {u.name}</span>
          </Button>
          <Button size="sm" variant="danger" disabled={readOnly} onClick={() => setDialog({ kind: 'revoke', user: u })}>
            Encerrar sessões<span className="sr-only"> de {u.name}</span>
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Usuários"
        subtitle="Pessoas com acesso a esta empresa."
        actions={<Button variant="primary" disabled={readOnly} onClick={() => setDialog({ kind: 'create' })}>Novo usuário</Button>}
      />
      <DataTable
        caption="Usuários da empresa"
        columns={columns}
        rows={users.data?.items}
        rowKey={(u) => u.id}
        loading={users.isLoading}
        error={users.isError ? errorMessage(users.error) : null}
        onRetry={() => void users.refetch()}
        emptyTitle="Nenhum usuário"
      />

      {dialog?.kind === 'create' && (
        <UserForm roles={roles.data?.items ?? []} onClose={close} onSecret={(value, name) => setSecret({ title: `Senha temporária de ${name}`, value })} />
      )}
      {dialog?.kind === 'edit' && <UserForm user={dialog.user} roles={roles.data?.items ?? []} onClose={close} />}

      <ConfirmDialog
        open={dialog?.kind === 'reset'}
        title="Redefinir senha"
        message={`Será gerada uma senha temporária para ${dialog?.kind === 'reset' ? dialog.user.name : ''} e as sessões dele serão encerradas.`}
        confirmLabel="Redefinir"
        destructive
        onCancel={close}
        onConfirm={async () => {
          if (dialog?.kind === 'reset') await reset.mutateAsync(dialog.user).catch(() => undefined);
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'revoke'}
        title="Encerrar sessões"
        message={`Todos os dispositivos de ${dialog?.kind === 'revoke' ? dialog.user.name : ''} serão desconectados.`}
        confirmLabel="Encerrar sessões"
        destructive
        onCancel={close}
        onConfirm={async () => {
          if (dialog?.kind === 'revoke') await revoke.mutateAsync(dialog.user).catch(() => undefined);
        }}
      />
      <SecretModal
        secret={secret?.value ?? null}
        title={secret?.title ?? ''}
        description="Entregue a senha ao usuário por um canal seguro."
        onClose={() => setSecret(null)}
      />
    </>
  );
}

function UserForm({ user, roles, onClose, onSecret }: {
  user?: UserItem;
  roles: RoleItem[];
  onClose: () => void;
  onSecret?: (secret: string, name: string) => void;
}) {
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [roleId, setRoleId] = useState(user?.roleId ?? '');
  const [status, setStatus] = useState<'active' | 'disabled'>(user?.status ?? 'active');
  const [password, setPassword] = useState('');

  const save = useWrite({
    inlineError: true,
    invalidate: [['users'], ['roles']],
    mutationFn: () =>
      user
        ? api.patch(`/users/${user.id}`, { name, roleId, status })
        : api.post<{ id: string; temporaryPassword?: string }>('/users', {
            name,
            email,
            roleId,
            ...(password ? { password } : {}),
          }),
    onSuccess: (result) => {
      onClose();
      const temp = (result as { temporaryPassword?: string } | undefined)?.temporaryPassword;
      if (!user && temp) onSecret?.(temp, name);
    },
    success: user ? 'Usuário atualizado.' : 'Usuário criado.',
  });

  return (
    <FormModal
      open
      title={user ? 'Editar usuário' : 'Novo usuário'}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      busy={save.isPending}
      submitDisabled={!roleId}
      error={save.errorText}
    >
      <Field label="Nome" required value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      <Field label="E-mail" type="email" required value={email} disabled={!!user} onChange={(e) => setEmail(e.target.value)} />
      <Select
        label="Papel"
        required
        placeholder="Selecione"
        value={roleId}
        onChange={(e) => setRoleId(e.target.value)}
        options={roles.map((r) => ({ value: r.id, label: r.name }))}
      />
      {user ? (
        <Select
          label="Situação"
          value={status}
          onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')}
          options={[{ value: 'active', label: 'Ativo' }, { value: 'disabled', label: 'Inativo' }]}
          hint="Ao inativar, as sessões do usuário são encerradas."
        />
      ) : (
        <Field
          label="Senha (opcional)"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="Deixe em branco para gerar uma senha temporária."
        />
      )}
    </FormModal>
  );
}
