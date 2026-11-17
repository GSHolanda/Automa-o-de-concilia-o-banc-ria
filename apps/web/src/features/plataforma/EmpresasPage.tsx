import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, errorMessage } from '../../api/client';
import { Badge, type BadgeTone } from '../../components/Badge';
import { Button } from '../../components/Button';
import { DataTable, type Column } from '../../components/DataTable';
import { DateText } from '../../components/DateText';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/Spinner';
import { FormModal, SecretModal, useWrite } from '../shared';

interface TenantItem {
  id: string;
  slug: string;
  legalName: string;
  tradeName: string;
  taxId: string | null;
  status: string;
  planCode: string | null;
  planName: string | null;
  licenseStatus: string | null;
  validUntil: string | null;
  userCount: number;
}
interface Plan { code: string; name: string; active: boolean }
interface License {
  planCode: string;
  status: string;
  validUntil: string | null;
  limitsOverride: Record<string, number | null>;
  externalRef: string | null;
  notes: string | null;
}
interface TenantDetail extends TenantItem { license: License | null }

const TENANT_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  onboarding: { label: 'Implantação', tone: 'info' },
  active: { label: 'Ativa', tone: 'success' },
  suspended: { label: 'Suspensa', tone: 'warning' },
  archived: { label: 'Arquivada', tone: 'neutral' },
};
const LICENSE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  trial: { label: 'Avaliação', tone: 'info' },
  active: { label: 'Ativa', tone: 'success' },
  past_due: { label: 'Em atraso', tone: 'warning' },
  suspended: { label: 'Suspensa', tone: 'danger' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};
const toOptions = (m: Record<string, { label: string }>) => Object.entries(m).map(([value, v]) => ({ value, label: v.label }));

function Tag({ map, value }: { map: Record<string, { label: string; tone: BadgeTone }>; value: string | null }) {
  if (!value) return <span className="texto-suave">—</span>;
  const e = map[value] ?? { label: value, tone: 'neutral' as BadgeTone };
  return <Badge tone={e.tone}>{e.label}</Badge>;
}

type Dialog = { kind: 'create' } | { kind: 'edit'; t: TenantItem } | { kind: 'license'; t: TenantItem } | null;

export function EmpresasPage() {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const tenants = useQuery({ queryKey: ['platform', 'tenants'], queryFn: () => api.get<{ items: TenantItem[] }>('/platform/tenants') });
  const plans = useQuery({ queryKey: ['platform', 'plans'], queryFn: () => api.get<{ items: Plan[] }>('/platform/plans') });
  const close = () => setDialog(null);

  const columns: Column<TenantItem>[] = [
    {
      key: 'name',
      header: 'Empresa',
      render: (t) => (
        <span>
          <strong>{t.tradeName}</strong>
          <span className="texto-suave" style={{ display: 'block' }}>{t.slug}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Situação', render: (t) => <Tag map={TENANT_STATUS} value={t.status} /> },
    { key: 'plan', header: 'Plano', render: (t) => t.planName ?? '—', hideOnMobile: true },
    { key: 'license', header: 'Licença', render: (t) => <Tag map={LICENSE_STATUS} value={t.licenseStatus} /> },
    { key: 'valid', header: 'Validade', render: (t) => (t.validUntil ? <DateText value={t.validUntil} /> : 'Sem prazo'), hideOnMobile: true },
    { key: 'users', header: 'Usuários', render: (t) => t.userCount, align: 'right', hideOnMobile: true },
    {
      key: 'actions',
      header: 'Ações',
      align: 'right',
      render: (t) => (
        <span className="linha" style={{ justifyContent: 'flex-end', gap: 'var(--e1)' }}>
          <Button size="sm" onClick={() => setDialog({ kind: 'edit', t })}>Editar<span className="sr-only"> {t.tradeName}</span></Button>
          <Button size="sm" onClick={() => setDialog({ kind: 'license', t })}>Licença<span className="sr-only"> de {t.tradeName}</span></Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Empresas"
        subtitle="Empresas da plataforma, planos e licenças."
        actions={<Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>Nova empresa</Button>}
      />
      <DataTable
        caption="Empresas"
        columns={columns}
        rows={tenants.data?.items}
        rowKey={(t) => t.id}
        loading={tenants.isLoading}
        error={tenants.isError ? errorMessage(tenants.error) : null}
        onRetry={() => void tenants.refetch()}
        emptyTitle="Nenhuma empresa cadastrada"
      />
      {dialog?.kind === 'create' && (
        <CreateForm plans={plans.data?.items ?? []} onClose={close} onSecret={(value, name) => setSecret({ title: `Administrador de ${name}`, value })} />
      )}
      {dialog?.kind === 'edit' && <EditForm tenant={dialog.t} onClose={close} />}
      {dialog?.kind === 'license' && <LicenseForm tenant={dialog.t} plans={plans.data?.items ?? []} onClose={close} />}
      <SecretModal
        secret={secret?.value ?? null}
        title={secret?.title ?? ''}
        description="Empresa criada. Entregue a senha ao administrador por um canal seguro."
        onClose={() => setSecret(null)}
      />
    </>
  );
}

const planOptions = (plans: Plan[], current?: string) =>
  plans.filter((p) => p.active || p.code === current).map((p) => ({ value: p.code, label: p.name }));

function CreateForm({ plans, onClose, onSecret }: { plans: Plan[]; onClose: () => void; onSecret: (s: string, name: string) => void }) {
  const [f, setF] = useState({ slug: '', legalName: '', tradeName: '', taxId: '', planCode: '', adminName: '', adminEmail: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useWrite({
    inlineError: true,
    invalidate: [['platform', 'tenants']],
    mutationFn: () =>
      api.post<{ tenantId: string; temporaryPassword: string }>('/platform/tenants', {
        slug: f.slug.trim(),
        legalName: f.legalName,
        tradeName: f.tradeName,
        taxId: f.taxId.trim() || null,
        planCode: f.planCode,
        admin: { name: f.adminName, email: f.adminEmail },
      }),
    success: 'Empresa criada.',
    onSuccess: (r) => {
      onClose();
      onSecret(r.temporaryPassword, f.tradeName);
    },
  });
  return (
    <FormModal open size="lg" title="Nova empresa" onClose={onClose} onSubmit={() => save.mutate()} busy={save.isPending} submitDisabled={!f.planCode} error={save.errorText}>
      <Field label="Identificador" required value={f.slug} onChange={set('slug')} pattern="[a-z0-9]([a-z0-9\-]{0,48}[a-z0-9])?" hint="Letras minúsculas, números e hífen (até 50 caracteres)." />
      <Field label="Razão social" required value={f.legalName} onChange={set('legalName')} maxLength={200} />
      <Field label="Nome fantasia" required value={f.tradeName} onChange={set('tradeName')} maxLength={200} />
      <Field label="CNPJ/CPF" value={f.taxId} onChange={set('taxId')} hint="Opcional. Apenas dígitos são gravados." />
      <Select label="Plano" required placeholder="Selecione" value={f.planCode} onChange={set('planCode')} options={planOptions(plans)} />
      <Field label="Nome do administrador" required value={f.adminName} onChange={set('adminName')} maxLength={120} />
      <Field label="E-mail do administrador" type="email" required value={f.adminEmail} onChange={set('adminEmail')} />
    </FormModal>
  );
}

function EditForm({ tenant, onClose }: { tenant: TenantItem; onClose: () => void }) {
  const [legalName, setLegalName] = useState(tenant.legalName);
  const [tradeName, setTradeName] = useState(tenant.tradeName);
  const [taxId, setTaxId] = useState(tenant.taxId ?? '');
  const [status, setStatus] = useState(tenant.status);
  const save = useWrite({
    inlineError: true,
    invalidate: [['platform', 'tenants']],
    mutationFn: () => api.patch(`/platform/tenants/${tenant.id}`, { legalName, tradeName, taxId: taxId.trim() || null, status }),
    success: 'Empresa atualizada.',
    onSuccess: onClose,
  });
  return (
    <FormModal open title={`Editar ${tenant.tradeName}`} onClose={onClose} onSubmit={() => save.mutate()} busy={save.isPending} error={save.errorText}>
      <Field label="Razão social" required value={legalName} onChange={(e) => setLegalName(e.target.value)} maxLength={200} />
      <Field label="Nome fantasia" required value={tradeName} onChange={(e) => setTradeName(e.target.value)} maxLength={200} />
      <Field label="CNPJ/CPF" value={taxId} onChange={(e) => setTaxId(e.target.value)} hint="Apenas dígitos são gravados." />
      <Select label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} options={toOptions(TENANT_STATUS)} />
    </FormModal>
  );
}

const LIMITS = [
  ['maxUsers', 'Máximo de usuários'],
  ['maxBankAccounts', 'Máximo de contas bancárias'],
  ['maxMonthlyTransactions', 'Máximo de transações por mês'],
] as const;

const limitText = (v: number | null | undefined) => (v === undefined ? '' : v === null ? 'ilimitado' : String(v));

function LicenseForm({ tenant, plans, onClose }: { tenant: TenantItem; plans: Plan[]; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['platform', 'tenants', tenant.id], queryFn: () => api.get<TenantDetail>(`/platform/tenants/${tenant.id}`) });
  return (
    <FormModalShell tenant={tenant} onClose={onClose} loading={detail.isLoading} error={detail.isError ? errorMessage(detail.error) : null}>
      {detail.data && <LicenseFields tenant={tenant} license={detail.data.license} plans={plans} onClose={onClose} />}
    </FormModalShell>
  );
}

/** Casca enquanto a licença atual carrega (ou falha). */
function FormModalShell({ tenant, onClose, loading, error, children }: { tenant: TenantItem; onClose: () => void; loading: boolean; error: string | null; children: ReactNode }) {
  if (!loading && !error) return <>{children}</>;
  return (
    <Modal open title={`Licença de ${tenant.tradeName}`} onClose={onClose} footer={<Button onClick={onClose}>Fechar</Button>}>
      {loading ? <Spinner label="Carregando licença" /> : <p className="campo-erro" role="alert">{error}</p>}
    </Modal>
  );
}

function LicenseFields({ tenant, license, plans, onClose }: { tenant: TenantItem; license: License | null; plans: Plan[]; onClose: () => void }) {
  const [planCode, setPlanCode] = useState(license?.planCode ?? '');
  const [status, setStatus] = useState(license?.status ?? 'active');
  const [validUntil, setValidUntil] = useState(license?.validUntil ?? '');
  const [limits, setLimits] = useState<Record<string, string>>(
    Object.fromEntries(LIMITS.map(([k]) => [k, limitText(license?.limitsOverride?.[k])])),
  );
  const [limitError, setLimitError] = useState<string | null>(null);

  const save = useWrite({
    inlineError: true,
    invalidate: [['platform', 'tenants']],
    mutationFn: () => {
      const limitsOverride: Record<string, number | null> = {};
      for (const [k] of LIMITS) {
        const text = limits[k]!.trim().toLowerCase();
        if (text === '') continue;
        limitsOverride[k] = text === 'ilimitado' ? null : Number(text);
      }
      return api.put(`/platform/tenants/${tenant.id}/license`, {
        planCode,
        status,
        validUntil: validUntil || null,
        limitsOverride,
        externalRef: license?.externalRef ?? null,
        notes: license?.notes ?? null,
      });
    },
    success: 'Licença atualizada.',
    onSuccess: onClose,
  });

  function submit() {
    const bad = LIMITS.find(([k]) => {
      const t = limits[k]!.trim().toLowerCase();
      return t !== '' && t !== 'ilimitado' && !/^\d+$/.test(t);
    });
    if (bad) {
      setLimitError(`${bad[1]}: informe um número inteiro, "ilimitado" ou deixe em branco.`);
      return;
    }
    setLimitError(null);
    save.mutate();
  }

  return (
    <FormModal open title={`Licença de ${tenant.tradeName}`} onClose={onClose} onSubmit={submit} busy={save.isPending} submitDisabled={!planCode} error={limitError ?? save.errorText}>
      <Select label="Plano" required placeholder="Selecione" value={planCode} onChange={(e) => setPlanCode(e.target.value)} options={planOptions(plans, license?.planCode)} />
      <Select label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} options={toOptions(LICENSE_STATUS)} />
      <Field label="Validade" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} hint="Em branco: sem prazo." />
      <fieldset style={{ border: '1px solid var(--cor-borda)', borderRadius: 4, padding: 'var(--e3)' }}>
        <legend>Limites (substituem o plano)</legend>
        <div className="pilha" style={{ gap: 'var(--e3)' }}>
          {LIMITS.map(([k, label]) => (
            <Field key={k} label={label} value={limits[k]} inputMode="numeric" onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} hint='Em branco usa o limite do plano; "ilimitado" remove o limite.' />
          ))}
        </div>
      </fieldset>
    </FormModal>
  );
}
