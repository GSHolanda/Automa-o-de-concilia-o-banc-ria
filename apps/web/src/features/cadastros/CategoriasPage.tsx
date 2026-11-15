import { RegistryPage, useRegistryList, type FieldDef, type RegistryRow } from './RegistryPage';
import { nameById } from './hierarquia';
import { CATEGORY_KIND_LABELS, label, options } from './rotulos';
import type { ChartAccount } from './PlanoDeContasPage';

export interface Category extends RegistryRow {
  code: string;
  name: string;
  kind: string;
  accountId: string | null;
}

export function CategoriasPage() {
  const accounts = useRegistryList<ChartAccount>('/chart-accounts');
  const accountName = nameById(accounts.data?.items);
  const fields: FieldDef<Category>[] = [
    { key: 'code', label: 'Código', type: 'text', required: true, maxLength: 40 },
    { key: 'name', label: 'Nome', type: 'text', required: true, maxLength: 120 },
    { key: 'kind', label: 'Tipo', type: 'select', required: true, options: options(CATEGORY_KIND_LABELS) },
    {
      key: 'accountId',
      label: 'Conta contábil',
      type: 'select',
      nullable: true,
      options: (accounts.data?.items ?? []).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
    },
    { key: 'active', label: 'Ativa', type: 'checkbox', defaultValue: true },
  ];
  return (
    <RegistryPage<Category>
      path="/categories"
      title="Categorias"
      subtitle="Categorias para classificar tarifas, impostos, juros e demais itens."
      noun="categoria"
      gender="a"
      fields={fields}
      columns={[
        { key: 'code', header: 'Código', width: '8rem' },
        { key: 'name', header: 'Nome' },
        { key: 'kind', header: 'Tipo', render: (r) => label(CATEGORY_KIND_LABELS, r.kind) },
        { key: 'account', header: 'Conta contábil', render: (r) => accountName(r.accountId), hideOnMobile: true },
      ]}
    />
  );
}
