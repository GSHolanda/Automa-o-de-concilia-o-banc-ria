import { useQuery } from '@tanstack/react-query';
import { PERMISSION_GROUPS, PERMISSIONS, type PermissionKey } from '@concilia/core/shared';
import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { Field } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { FormModal, useWrite } from '../shared';

interface RoleItem {
  id: string;
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

type Dialog = { kind: 'form'; role?: RoleItem } | { kind: 'delete'; role: RoleItem } | null;

export function PapeisPage() {
  const { readOnly } = useAuth();
  const [dialog, setDialog] = useState<Dialog>(null);
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ items: RoleItem[] }>('/roles') });
  const close = () => setDialog(null);

  const remove = useWrite({
    mutationFn: (r: RoleItem) => api.delete(`/roles/${r.id}`),
    invalidate: [['roles']],
    success: 'Papel excluído.',
    onSuccess: close,
  });

  const columns: Column<RoleItem>[] = [
    {
      key: 'name',
      header: 'Papel',
      render: (r) => (
        <span>
          <strong>{r.name}</strong> {r.isSystem && <Badge tone="info">Sistema</Badge>}
          {r.description && <span className="texto-suave" style={{ display: 'block' }}>{r.description}</span>}
        </span>
      ),
    },
    { key: 'perms', header: 'Permissões', render: (r) => r.permissions.length, align: 'right', hideOnMobile: true },
    { key: 'users', header: 'Usuários', render: (r) => r.userCount, align: 'right' },
    {
      key: 'actions',
      header: 'Ações',
      align: 'right',
      render: (r) => (
        <span className="linha" style={{ justifyContent: 'flex-end', gap: 'var(--e1)' }}>
          <Button size="sm" onClick={() => setDialog({ kind: 'form', role: r })} disabled={!r.isSystem && readOnly}>
            {r.isSystem ? 'Ver' : 'Editar'}<span className="sr-only"> {r.name}</span>
          </Button>
          {!r.isSystem && (
            <Button size="sm" variant="danger" disabled={readOnly || r.userCount > 0} title={r.userCount > 0 ? 'Papel em uso por usuários' : undefined} onClick={() => setDialog({ kind: 'delete', role: r })}>
              Excluir<span className="sr-only"> {r.name}</span>
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Papéis"
        subtitle="Conjuntos de permissões atribuídos aos usuários."
        actions={<Button variant="primary" disabled={readOnly} onClick={() => setDialog({ kind: 'form' })}>Novo papel</Button>}
      />
      <DataTable
        caption="Papéis da empresa"
        columns={columns}
        rows={roles.data?.items}
        rowKey={(r) => r.id}
        loading={roles.isLoading}
        error={roles.isError ? errorMessage(roles.error) : null}
        onRetry={() => void roles.refetch()}
        emptyTitle="Nenhum papel"
      />
      {dialog?.kind === 'form' && <RoleForm role={dialog.role} onClose={close} />}
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title="Excluir papel"
        message={`O papel "${dialog?.kind === 'delete' ? dialog.role.name : ''}" será excluído. Esta ação não pode ser desfeita.`}
        confirmLabel="Excluir"
        destructive
        onCancel={close}
        onConfirm={async () => {
          if (dialog?.kind === 'delete') await remove.mutateAsync(dialog.role).catch(() => undefined);
        }}
      />
    </>
  );
}

function RoleForm({ role, onClose }: { role?: RoleItem; onClose: () => void }) {
  const { readOnly } = useAuth();
  const locked = role?.isSystem === true;
  const disabled = locked || readOnly;
  const [key, setKey] = useState(role?.key ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));

  const save = useWrite({
    inlineError: true,
    invalidate: [['roles'], ['users']],
    mutationFn: () => {
      const permissions = [...selected];
      return role
        ? api.patch(`/roles/${role.id}`, { name, description, permissions })
        : api.post('/roles', { key, name, description, permissions });
    },
    success: role ? 'Papel atualizado.' : 'Papel criado.',
    onSuccess: onClose,
  });

  const toggle = (perm: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(perm);
      else next.delete(perm);
      return next;
    });

  const form = (
    <>
      {!role && (
        <Field
          label="Chave"
          required
          value={key}
          pattern="[a-z0-9_\-]{2,40}"
          hint="De 2 a 40 letras minúsculas, números, hífen ou sublinhado. Não pode ser alterada."
          onChange={(e) => setKey(e.target.value)}
        />
      )}
      <Field label="Nome" required value={name} maxLength={80} disabled={disabled} onChange={(e) => setName(e.target.value)} />
      <Field label="Descrição" multiline rows={2} maxLength={500} value={description} disabled={disabled} onChange={(e) => setDescription(e.target.value)} />
      {PERMISSION_GROUPS.map((group) => (
        <fieldset key={group.label} style={{ border: '1px solid var(--cor-borda)', borderRadius: 4, padding: 'var(--e3)' }}>
          <legend>{group.label}</legend>
          <div className="pilha" style={{ gap: 'var(--e2)' }}>
            {group.keys.map((perm: PermissionKey) => (
              <Checkbox
                key={perm}
                label={PERMISSIONS[perm]}
                hint={perm}
                checked={selected.has(perm)}
                disabled={disabled}
                onChange={(e) => toggle(perm, e.target.checked)}
              />
            ))}
          </div>
        </fieldset>
      ))}
    </>
  );

  if (locked) {
    return (
      <FormModal open title={`Papel: ${role.name}`} onClose={onClose} onSubmit={onClose} submitLabel="Fechar" size="lg">
        <p className="texto-suave">Papéis do sistema são somente leitura.</p>
        {form}
      </FormModal>
    );
  }
  return (
    <FormModal
      open
      size="lg"
      title={role ? 'Editar papel' : 'Novo papel'}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      busy={save.isPending}
      submitDisabled={readOnly}
      error={save.errorText}
    >
      {form}
    </FormModal>
  );
}
