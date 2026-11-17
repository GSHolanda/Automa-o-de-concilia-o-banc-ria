import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Spinner } from '../../components/Spinner';
import { useWrite } from '../shared';

type StepKey = 'company' | 'branding' | 'bank_accounts' | 'structure' | 'chart' | 'import_profile' | 'rules' | 'users';

interface Step {
  key: StepKey;
  title: string;
  required: boolean;
  done: boolean;
}
interface Onboarding {
  status: string;
  steps: Step[];
  canComplete: boolean;
}
interface TemplateResult {
  template: string;
  accountsCreated: number;
  accountsExisting: number;
  categoriesCreated: number;
  categoriesExisting: number;
}

const KEY = ['onboarding'] as const;
const TEMPLATE = 'plano-de-contas-basico';

const GUIDE: Record<StepKey, { text: string; to: string; action: string }> = {
  company: { text: 'Razão social, nome fantasia e CNPJ/CPF. Aparecem nos relatórios e na barra superior.', to: '/configuracoes/empresa', action: 'Abrir dados da empresa' },
  branding: { text: 'Logotipo e cor principal da empresa para personalizar a interface.', to: '/configuracoes/identidade-visual', action: 'Abrir identidade visual' },
  bank_accounts: { text: 'Cadastre as contas bancárias que serão conciliadas. É preciso ao menos uma ativa.', to: '/configuracoes/contas-bancarias', action: 'Abrir contas bancárias' },
  structure: { text: 'Unidades, departamentos e centros de custo, se a empresa quiser separar os resultados.', to: '/configuracoes/estrutura', action: 'Abrir estrutura' },
  chart: { text: 'Contas contábeis e categorias usadas para classificar tarifas, juros e outros itens. Você pode partir de um modelo básico e ajustar depois.', to: '/configuracoes/plano-de-contas', action: 'Abrir plano de contas' },
  import_profile: { text: 'Ensina o sistema a ler o arquivo do banco e o de lançamentos: quais colunas são data, valor e descrição.', to: '/configuracoes/perfis-importacao', action: 'Abrir perfis de importação' },
  rules: { text: 'Regras que classificam automaticamente itens recorrentes, como tarifas, pelo texto da descrição.', to: '/configuracoes/classificacao', action: 'Abrir regras de classificação' },
  users: { text: 'Convide quem vai conciliar e quem vai aprovar, com o papel adequado a cada um.', to: '/configuracoes/usuarios', action: 'Abrir usuários' },
};

export function ImplantacaoPage() {
  const { can, readOnly, refresh } = useAuth();
  const canWrite = can('settings.manage') && !readOnly;
  const [template, setTemplate] = useState<TemplateResult | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const state = useQuery({ queryKey: KEY, queryFn: () => api.get<Onboarding>('/onboarding') });

  const mark = useWrite({
    mutationFn: (v: { key: StepKey; done: boolean }) => api.put<Onboarding>(`/onboarding/steps/${v.key}`, { done: v.done }),
    invalidate: [KEY],
  });
  const apply = useWrite({
    mutationFn: () => api.post<TemplateResult>('/onboarding/apply-template', { template: TEMPLATE }),
    invalidate: [KEY, ['chart-accounts'], ['categories']],
    success: (r) => `Plano de contas aplicado: ${r.accountsCreated} contas e ${r.categoriesCreated} categorias criadas.`,
    onSuccess: setTemplate,
  });
  const complete = useWrite({
    inlineError: true,
    mutationFn: () => api.post<Onboarding>('/onboarding/complete'),
    invalidate: [KEY],
    success: 'Implantação concluída. A empresa está ativa.',
    onSuccess: () => {
      setMissing(null);
      void refresh();
    },
  });

  if (state.isLoading) return <Spinner label="Carregando implantação" />;
  if (state.isError || !state.data) {
    return (
      <>
        <PageHeader title="Implantação" />
        <EmptyState tone="error" title="Não foi possível carregar a implantação" description={errorMessage(state.error)} action={<Button onClick={() => void state.refetch()}>Tentar de novo</Button>} />
      </>
    );
  }

  const { steps, status } = state.data;
  const doneCount = steps.filter((s) => s.done).length;
  const pct = steps.length ? Math.round((doneCount / steps.length) * 100) : 0;
  const finished = status !== 'onboarding';
  const titleOf = (key: string) => steps.find((s) => s.key === key)?.title ?? key;

  async function finish() {
    setMissing(null);
    try {
      await complete.mutateAsync();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'onboarding_incomplete') {
        const list = (error.details as { missing?: string[] } | undefined)?.missing;
        setMissing(list && list.length > 0 ? list : steps.filter((s) => s.required && !s.done).map((s) => s.key));
      }
    }
  }

  return (
    <>
      <PageHeader title="Implantação" subtitle="Siga as etapas para deixar a empresa pronta para conciliar. As marcadas com asterisco são obrigatórias." />

      <div className="cartao pilha" style={{ gap: 'var(--e2)', marginBottom: 'var(--e4)' }}>
        <div className="linha" style={{ justifyContent: 'space-between' }}>
          <strong>{doneCount} de {steps.length} etapas concluídas</strong>
          {finished && <Badge tone="success">Implantação concluída</Badge>}
        </div>
        <div role="progressbar" aria-label="Progresso da implantação" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
          style={{ height: 10, borderRadius: 5, background: 'var(--cor-borda)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--cor-primaria)' }} />
        </div>
      </div>

      <ol className="pilha" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 'var(--e3)' }}>
        {steps.map((step, index) => {
          const guide = GUIDE[step.key];
          return (
            <li key={step.key} className="cartao pilha" style={{ gap: 'var(--e3)' }}>
              <div className="linha" style={{ justifyContent: 'space-between' }}>
                <h2 style={{ fontSize: '1.05rem', margin: 0 }}>
                  {index + 1}. {step.title}{step.required && <span aria-label="obrigatória"> *</span>}
                </h2>
                <Badge tone={step.done ? 'success' : step.required ? 'warning' : 'neutral'}>{step.done ? 'Concluída' : step.required ? 'Pendente' : 'Opcional'}</Badge>
              </div>
              <p className="texto-suave" style={{ margin: 0 }}>{guide.text}</p>
              <div className="linha">
                <Link to={guide.to} className="btn btn-secondary">{guide.action}</Link>
                {step.key === 'chart' && (
                  <Button disabled={!canWrite} loading={apply.isPending} onClick={() => apply.mutate()}>Aplicar plano de contas modelo</Button>
                )}
                <Button variant="ghost" disabled={!canWrite || mark.isPending} onClick={() => mark.mutate({ key: step.key, done: !step.done })}>
                  {step.done ? 'Marcar como pendente' : 'Marcar como concluída'}<span className="sr-only"> {step.title}</span>
                </Button>
              </div>
              {step.key === 'chart' && template && (
                <p className="texto-suave" role="status" style={{ margin: 0 }}>
                  Modelo aplicado: {template.accountsCreated} contas e {template.categoriesCreated} categorias criadas
                  {template.accountsExisting + template.categoriesExisting > 0 && `; ${template.accountsExisting} contas e ${template.categoriesExisting} categorias já existiam e foram mantidas`}.
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <section className="cartao pilha" style={{ marginTop: 'var(--e4)' }}>
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Concluir implantação</h2>
        {finished ? (
          <p className="texto-suave" style={{ margin: 0 }}>A implantação já foi concluída e a empresa está ativa.</p>
        ) : (
          <>
            <p className="texto-suave" style={{ margin: 0 }}>
              Ao concluir, a empresa passa a ser tratada como ativa e o aviso de implantação some. Exigem-se os dados da empresa e ao menos uma conta bancária.
            </p>
            {missing && (
              <div className="erro-texto" role="alert">
                Ainda falta concluir:
                <ul>{missing.map((key) => <li key={key}>{titleOf(key)}</li>)}</ul>
              </div>
            )}
            {complete.errorText && !missing && <p className="erro-texto" role="alert">{complete.errorText}</p>}
            <div><Button variant="primary" disabled={!canWrite} loading={complete.isPending} onClick={() => void finish()}>Concluir implantação</Button></div>
          </>
        )}
      </section>
    </>
  );
}
