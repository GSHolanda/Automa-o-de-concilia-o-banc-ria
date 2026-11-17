import { RegistryPage, useRegistryList, type FieldDef, type RegistryRow } from './RegistryPage';
import { nameById } from './hierarquia';
import type { ChartAccount } from './PlanoDeContasPage';

interface BankAccount extends RegistryRow {
  name: string;
  bankCode: string | null;
  bankName: string | null;
  branch: string | null;
  accountNumber: string | null;
  currency: string;
  unitId: string | null;
  ledgerAccountId: string | null;
  externalRef: string | null;
}
interface Unit {
  id: string;
  code: string;
  name: string;
}

export function ContasBancariasPage() {
  const units = useRegistryList<Unit>('/org-nodes', { kind: 'unit' });
  const accounts = useRegistryList<ChartAccount>('/chart-accounts');
  const unitName = nameById(units.data?.items);
  const fields: FieldDef<BankAccount>[] = [
    { key: 'name', label: 'Nome', type: 'text', required: true, maxLength: 120 },
    { key: 'bankCode', label: 'Código do banco', type: 'text', nullable: true, maxLength: 8, pattern: '[0-9]{1,8}', hint: 'Apenas dígitos, por exemplo 341.' },
    { key: 'bankName', label: 'Banco', type: 'text', nullable: true, maxLength: 120 },
    { key: 'branch', label: 'Agência', type: 'text', nullable: true, maxLength: 40 },
    { key: 'accountNumber', label: 'Número da conta', type: 'text', nullable: true, maxLength: 40 },
    { key: 'currency', label: 'Moeda', type: 'text', maxLength: 3, pattern: '[A-Z]{3}', defaultValue: 'BRL', hint: 'Código de três letras maiúsculas, por exemplo BRL.' },
    { key: 'unitId', label: 'Unidade', type: 'select', nullable: true, options: (units.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` })) },
    { key: 'ledgerAccountId', label: 'Conta contábil', type: 'select', nullable: true, options: (accounts.data?.items ?? []).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })) },
    { key: 'externalRef', label: 'Referência externa', type: 'text', nullable: true, maxLength: 120, hint: 'Identificador da conta no sistema financeiro, se houver.' },
    { key: 'active', label: 'Ativa', type: 'checkbox', defaultValue: true, hint: 'O plano limita o número de contas ativas.' },
  ];
  return (
    <RegistryPage<BankAccount>
      path="/bank-accounts"
      title="Contas bancárias"
      subtitle="Contas cujos extratos são conciliados."
      noun="conta bancária"
      gender="a"
      fields={fields}
      columns={[
        { key: 'name', header: 'Nome' },
        { key: 'bank', header: 'Banco', render: (r) => [r.bankCode, r.bankName].filter(Boolean).join(' — ') || '—', hideOnMobile: true },
        { key: 'number', header: 'Agência / conta', render: (r) => [r.branch, r.accountNumber].filter(Boolean).join(' / ') || '—', hideOnMobile: true },
        { key: 'currency', header: 'Moeda' },
        { key: 'unit', header: 'Unidade', render: (r) => unitName(r.unitId), hideOnMobile: true },
      ]}
    />
  );
}
