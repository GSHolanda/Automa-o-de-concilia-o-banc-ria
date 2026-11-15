import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { DataTable, type Column } from '../../components/DataTable';
import { DateText } from '../../components/DateText';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Spinner } from '../../components/Spinner';
import { useWrite } from '../shared';

interface ModuleItem {
  key: string;
  name: string;
  description: string;
  required: boolean;
  inPlan: boolean;
  enabled: boolean;
  externalDependency: string | null;
}

interface License {
  planCode: string | null;
  planName: string | null;
  licenseStatus: string | null;
  validUntil: string | null;
  readOnly: boolean;
  readOnlyReason: string | null;
  limits: { maxUsers: number | null; maxBankAccounts: number | null; maxMonthlyTransactions: number | null };
}

const STATUS_LABELS: Record<string, string> = {
  trial: 'Período de avaliação',
  active: 'Ativa',
  past_due: 'Pagamento em atraso',
  suspended: 'Suspensa',
  canceled: 'Cancelada',
};
const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  trial: 'info',
  active: 'success',
  past_due: 'warning',
  suspended: 'danger',
  canceled: 'danger',
};

const limitText = (v: number | null | undefined) => (v === null || v === undefined ? 'Sem limite' : v.toLocaleString('pt-BR'));

function LicenseBlock() {
  const license = useQuery({ queryKey: ['license'], queryFn: () => api.get<License>('/license') });
  const l = license.data;
  return (
    <section className="cartao pilha" aria-labelledby="licenca-titulo" style={{ marginBottom: 'var(--e5)' }}>
      <h2 id="licenca-titulo" style={{ margin: 0 }}>Licença</h2>
      {license.isLoading && <Spinner label="Carregando licença" />}
      {license.isError && (
        <EmptyState
          tone="error"
          title="Não foi possível carregar a licença"
          description={errorMessage(license.error)}
          action={<Button onClick={() => void license.refetch()}>Tentar novamente</Button>}
        />
      )}
      {l && (
        <>
          <dl className="grade-2" style={{ margin: 0 }}>
            <div><dt className="texto-suave">Plano</dt><dd style={{ margin: 0 }}><strong>{l.planName ?? 'Sem plano'}</strong>{l.planCode ? ` (${l.planCode})` : ''}</dd></div>
            <div>
              <dt className="texto-suave">Situação</dt>
              <dd style={{ margin: 0 }}>
                {l.licenseStatus ? <Badge tone={STATUS_TONE[l.licenseStatus] ?? 'neutral'}>{STATUS_LABELS[l.licenseStatus] ?? l.licenseStatus}</Badge> : '—'}
              </dd>
            </div>
            <div><dt className="texto-suave">Validade</dt><dd style={{ margin: 0 }}>{l.validUntil ? <DateText value={l.validUntil} /> : 'Sem data de expiração'}</dd></div>
            <div>
              <dt className="texto-suave">Modo somente leitura</dt>
              <dd style={{ margin: 0 }}>
                {l.readOnly ? <Badge tone="warning">Ativo</Badge> : <Badge tone="success">Inativo</Badge>}
                {l.readOnly && l.readOnlyReason && <span className="texto-suave" style={{ display: 'block' }}>{l.readOnlyReason}</span>}
              </dd>
            </div>
            <div><dt className="texto-suave">Usuários</dt><dd style={{ margin: 0 }}>{limitText(l.limits.maxUsers)}</dd></div>
            <div><dt className="texto-suave">Contas bancárias ativas</dt><dd style={{ margin: 0 }}>{limitText(l.limits.maxBankAccounts)}</dd></div>
            <div><dt className="texto-suave">Transações por mês</dt><dd style={{ margin: 0 }}>{limitText(l.limits.maxMonthlyTransactions)}</dd></div>
          </dl>
        </>
      )}
    </section>
  );
}

export function ModulosPage() {
  const { can, readOnly, refresh } = useAuth();
  const writable = can('modules.manage') && !readOnly;
  const modules = useQuery({ queryKey: ['modules'], queryFn: () => api.get<{ items: ModuleItem[] }>('/modules') });

  const toggle = useWrite({
    mutationFn: (m: ModuleItem) => api.put(`/modules/${encodeURIComponent(m.key)}`, { enabled: !m.enabled }),
    invalidate: [['modules'], ['license']],
    success: (_r, m) => `Módulo ${m.name} ${m.enabled ? 'desabilitado' : 'habilitado'}.`,
    onSuccess: () => void refresh(),
  });

  const yesNo = (v: boolean) => <Badge tone={v ? 'success' : 'neutral'}>{v ? 'Sim' : 'Não'}</Badge>;

  const columns: Column<ModuleItem>[] = [
    {
      key: 'name',
      header: 'Módulo',
      render: (m) => (
        <span>
          <strong>{m.name}</strong>
          <span className="texto-suave" style={{ display: 'block' }}>{m.description}</span>
        </span>
      ),
    },
    { key: 'required', header: 'Obrigatório', render: (m) => yesNo(m.required), hideOnMobile: true },
    { key: 'inPlan', header: 'No plano', render: (m) => yesNo(m.inPlan), hideOnMobile: true },
    { key: 'enabled', header: 'Habilitado', render: (m) => yesNo(m.enabled) },
    { key: 'ext', header: 'Dependência externa', render: (m) => m.externalDependency ?? '—', hideOnMobile: true },
    {
      key: 'actions',
      header: 'Ação',
      align: 'right',
      render: (m) => {
        const reason = m.required ? 'Módulo obrigatório' : !m.inPlan ? 'Fora do plano da empresa' : undefined;
        return (
          <Button
            size="sm"
            variant={m.enabled ? 'secondary' : 'primary'}
            disabled={!writable || m.required || !m.inPlan || toggle.isPending}
            title={reason}
            onClick={() => toggle.mutate(m)}
          >
            {m.enabled ? 'Desabilitar' : 'Habilitar'}<span className="sr-only"> {m.name}</span>
          </Button>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title="Módulos" subtitle="Recursos do produto disponíveis para a empresa e a licença em vigor." />
      <LicenseBlock />
      <DataTable
        caption="Catálogo de módulos"
        columns={columns}
        rows={modules.data?.items}
        rowKey={(m) => m.key}
        loading={modules.isLoading}
        error={modules.isError ? errorMessage(modules.error) : null}
        onRetry={() => void modules.refetch()}
        emptyTitle="Nenhum módulo no catálogo"
      />
    </>
  );
}
