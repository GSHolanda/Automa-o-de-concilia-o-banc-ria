import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { Spinner } from '../../components/Spinner';
import { useWrite } from '../shared';

interface Company {
  id: string;
  slug: string;
  legalName: string;
  tradeName: string;
  taxId: string | null;
  status: string;
}

/** 14 dígitos: 00.000.000/0000-00; 11 dígitos: CPF. Outros valores aparecem como digitados. */
function formatTaxId(value: string): string {
  const d = value.replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return value;
}

export function EmpresaPage() {
  const { can, readOnly, refresh } = useAuth();
  const writable = can('settings.manage') && !readOnly;
  const company = useQuery({ queryKey: ['company'], queryFn: () => api.get<Company>('/company') });
  const [legalName, setLegalName] = useState('');
  const [tradeName, setTradeName] = useState('');
  const [taxId, setTaxId] = useState('');

  const data = company.data;
  useEffect(() => {
    if (!data) return;
    setLegalName(data.legalName);
    setTradeName(data.tradeName);
    setTaxId(data.taxId ? formatTaxId(data.taxId) : '');
  }, [data]);

  const save = useWrite({
    inlineError: true,
    invalidate: [['company']],
    mutationFn: () => api.patch<Company>('/company', { legalName, tradeName, taxId }),
    success: 'Dados da empresa salvos.',
    onSuccess: () => void refresh(),
  });

  const digits = taxId.replace(/\D/g, '');
  const taxIdError = taxId !== '' && digits.length !== 11 && digits.length !== 14 ? 'Informe 14 dígitos (CNPJ) ou 11 (CPF).' : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!taxIdError) save.mutate();
  }

  return (
    <>
      <PageHeader title="Empresa" subtitle="Dados cadastrais da empresa." />
      {company.isLoading && <Spinner label="Carregando dados da empresa" />}
      {company.isError && (
        <EmptyState
          tone="error"
          title="Não foi possível carregar os dados da empresa"
          description={errorMessage(company.error)}
          action={<Button onClick={() => void company.refetch()}>Tentar novamente</Button>}
        />
      )}
      {data && (
        <form className="cartao pilha" style={{ maxWidth: 560 }} onSubmit={submit}>
          <Field label="Razão social" required maxLength={200} value={legalName} disabled={!writable} onChange={(e) => setLegalName(e.target.value)} />
          <Field label="Nome fantasia" required maxLength={200} value={tradeName} disabled={!writable} onChange={(e) => setTradeName(e.target.value)} />
          <Field
            label="CNPJ"
            hint="Também aceita CPF. A pontuação é opcional."
            inputMode="numeric"
            maxLength={18}
            value={taxId}
            error={taxIdError}
            disabled={!writable}
            onChange={(e) => setTaxId(e.target.value)}
          />
          {save.errorText && <p className="campo-erro" role="alert">{save.errorText}</p>}
          <div className="linha">
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!writable || legalName.trim() === '' || tradeName.trim() === ''}>
              Salvar
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
