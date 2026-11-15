import { useQuery } from '@tanstack/react-query';
import type { ImportProfileConfig } from '@concilia/core/shared';
import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { Field } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { Select } from '../../components/Select';
import { useWrite } from '../shared';
import { cleanImportMapping, defaultImportMapping, ImportMappingEditor, validateImportMapping } from './ImportMappingEditor';

type SourceKind = 'bank' | 'ledger';
type FileFormat = 'csv' | 'xlsx';

interface ImportProfile {
  id: string;
  name: string;
  sourceKind: SourceKind;
  fileFormat: FileFormat;
  config: ImportProfileConfig;
  active: boolean;
  updatedAt: string;
}

export const PROFILES_KEY = ['import-profiles'] as const;
const SOURCE_LABEL: Record<SourceKind, string> = { bank: 'Extrato bancário', ledger: 'Lançamentos' };

type Dialog = { kind: 'form'; profile?: ImportProfile } | { kind: 'delete'; profile: ImportProfile } | null;

export function PerfisImportacaoPage() {
  const { can, readOnly } = useAuth();
  const canWrite = can('settings.manage') && !readOnly;
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  const profiles = useQuery({ queryKey: PROFILES_KEY, queryFn: () => api.get<{ items: ImportProfile[] }>('/import-profiles') });

  const remove = useWrite({
    mutationFn: (p: ImportProfile) => api.delete(`/import-profiles/${p.id}`),
    invalidate: [PROFILES_KEY, ['onboarding']],
    success: 'Perfil excluído.',
    onSuccess: close,
  });
  const toggle = useWrite({
    mutationFn: (p: ImportProfile) => api.patch(`/import-profiles/${p.id}`, { active: !p.active }),
    invalidate: [PROFILES_KEY],
    success: (_r, p) => (p.active ? 'Perfil desativado.' : 'Perfil ativado.'),
  });

  const columns: Column<ImportProfile>[] = [
    { key: 'name', header: 'Perfil', render: (p) => <strong>{p.name}</strong> },
    { key: 'source', header: 'Origem', render: (p) => SOURCE_LABEL[p.sourceKind], hideOnMobile: true },
    { key: 'format', header: 'Formato', render: (p) => p.fileFormat.toUpperCase(), hideOnMobile: true },
    { key: 'active', header: 'Situação', render: (p) => <Badge tone={p.active ? 'success' : 'neutral'}>{p.active ? 'Ativo' : 'Inativo'}</Badge> },
    {
      key: 'actions',
      header: 'Ações',
      align: 'right',
      render: (p) => (
        <span className="linha" style={{ justifyContent: 'flex-end', gap: 'var(--e1)' }}>
          <Button size="sm" onClick={() => setDialog({ kind: 'form', profile: p })}>
            {canWrite ? 'Editar' : 'Ver'}<span className="sr-only"> {p.name}</span>
          </Button>
          {canWrite && (
            <>
              <Button size="sm" onClick={() => toggle.mutate(p)} disabled={toggle.isPending}>
                {p.active ? 'Desativar' : 'Ativar'}<span className="sr-only"> {p.name}</span>
              </Button>
              <Button size="sm" variant="danger" onClick={() => setDialog({ kind: 'delete', profile: p })}>
                Excluir<span className="sr-only"> {p.name}</span>
              </Button>
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Perfis de importação"
        subtitle="Ensinam o sistema a ler o arquivo de cada banco ou sistema contábil: quais colunas são data, valor e descrição."
        actions={<Button variant="primary" disabled={!canWrite} onClick={() => setDialog({ kind: 'form' })}>Novo perfil</Button>}
      />
      <DataTable
        caption="Perfis de importação"
        columns={columns}
        rows={profiles.data?.items}
        rowKey={(p) => p.id}
        loading={profiles.isLoading}
        error={profiles.isError ? errorMessage(profiles.error) : null}
        onRetry={() => void profiles.refetch()}
        emptyTitle="Nenhum perfil de importação"
        emptyDescription="Crie um perfil para cada layout de arquivo que a empresa recebe."
        emptyAction={canWrite ? <Button variant="primary" onClick={() => setDialog({ kind: 'form' })}>Novo perfil</Button> : undefined}
      />
      {dialog?.kind === 'form' && <ProfileEditor profile={dialog.profile} readOnly={!canWrite} onClose={close} />}
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title="Excluir perfil"
        message={`O perfil "${dialog?.kind === 'delete' ? dialog.profile.name : ''}" será excluído. Perfis usados em importações anteriores não podem ser excluídos; nesse caso, desative-o.`}
        confirmLabel="Excluir"
        destructive
        onCancel={close}
        onConfirm={async () => {
          if (dialog?.kind === 'delete') await remove.mutateAsync(dialog.profile).catch(() => undefined);
        }}
      />
    </>
  );
}

function ProfileEditor({ profile, readOnly, onClose }: { profile?: ImportProfile; readOnly: boolean; onClose: () => void }) {
  const [name, setName] = useState(profile?.name ?? '');
  const [sourceKind, setSourceKind] = useState<SourceKind>(profile?.sourceKind ?? 'bank');
  const [fileFormat, setFileFormat] = useState<FileFormat>(profile?.fileFormat ?? 'csv');
  const [active, setActive] = useState(profile?.active ?? true);
  const [config, setConfig] = useState<ImportProfileConfig>(() =>
    profile ? { ...defaultImportMapping(), ...profile.config, columns: { ...profile.config.columns } } : defaultImportMapping(),
  );
  const [attempted, setAttempted] = useState(false);

  const mappingErrors = validateImportMapping(config);
  const nameError = name.trim() ? (name.trim().length > 120 ? 'Use no máximo 120 caracteres.' : null) : 'Informe o nome do perfil.';
  const invalid = nameError !== null || Object.keys(mappingErrors).length > 0;

  const save = useWrite({
    inlineError: true,
    invalidate: [PROFILES_KEY, ['onboarding']],
    success: profile ? 'Perfil salvo.' : 'Perfil criado.',
    mutationFn: () => {
      const body = { name: name.trim(), sourceKind, fileFormat, active, config: cleanImportMapping(config) };
      return profile ? api.patch(`/import-profiles/${profile.id}`, body) : api.post('/import-profiles', body);
    },
    onSuccess: onClose,
  });

  return (
    <Drawer
      open
      title={profile ? (readOnly ? `Perfil: ${profile.name}` : `Editar perfil: ${profile.name}`) : 'Novo perfil de importação'}
      onClose={() => !save.isPending && onClose()}
      width="xl"
      footer={
        <>
          {save.errorText && <span className="erro-texto" role="alert" style={{ marginRight: 'auto' }}>{save.errorText}</span>}
          <Button onClick={onClose} disabled={save.isPending}>{readOnly ? 'Fechar' : 'Cancelar'}</Button>
          {!readOnly && (
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() => {
                setAttempted(true);
                if (!invalid) save.mutate();
              }}
            >
              Salvar
            </Button>
          )}
        </>
      }
    >
      <div className="pilha" style={{ gap: 'var(--e5)' }}>
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} className="pilha">
          <Field label="Nome do perfil" required value={name} onChange={(e) => setName(e.target.value)} error={attempted ? nameError : null}
            hint="Ex.: Extrato Banco X (CSV)." />
          <div style={{ display: 'grid', gap: 'var(--e4)', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', alignItems: 'start' }}>
            <Select label="Origem" value={sourceKind} onChange={(e) => setSourceKind(e.target.value as SourceKind)}
              hint="Extrato: movimentos do banco. Lançamentos: o que a empresa registrou (ERP, planilha)."
              options={[{ value: 'bank', label: SOURCE_LABEL.bank }, { value: 'ledger', label: SOURCE_LABEL.ledger }]} />
            <Select label="Formato do arquivo" value={fileFormat} onChange={(e) => setFileFormat(e.target.value as FileFormat)}
              options={[{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'Planilha (XLSX)' }]} />
          </div>
          <Checkbox label="Perfil ativo" checked={active} onChange={(e) => setActive(e.target.checked)} hint="Perfis inativos não aparecem para novas importações." />
        </fieldset>
        <ImportMappingEditor
          value={config}
          onChange={setConfig}
          fileFormat={fileFormat}
          disabled={readOnly}
          errors={attempted ? mappingErrors : {}}
        />
      </div>
    </Drawer>
  );
}
