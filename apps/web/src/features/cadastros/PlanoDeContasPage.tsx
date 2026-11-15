import { RegistryPage, useRegistryList, type FieldDef, type RegistryRow } from './RegistryPage';
import { nameById, parentOptions } from './hierarquia';
import { ACCOUNT_TYPE_LABELS, label, options } from './rotulos';

export interface ChartAccount extends RegistryRow {
  code: string;
  name: string;
  accountType: string;
  parentId: string | null;
}

const FIELDS: FieldDef<ChartAccount>[] = [
  { key: 'code', label: 'Código', type: 'text', required: true, maxLength: 40 },
  { key: 'name', label: 'Nome', type: 'text', required: true, maxLength: 160 },
  { key: 'accountType', label: 'Tipo', type: 'select', required: true, options: options(ACCOUNT_TYPE_LABELS) },
  { key: 'parentId', label: 'Conta superior', type: 'select', nullable: true, options: parentOptions, placeholder: 'Nenhuma (nível raiz)' },
  { key: 'active', label: 'Ativa', type: 'checkbox', defaultValue: true },
];

export function PlanoDeContasPage() {
  const list = useRegistryList<ChartAccount>('/chart-accounts');
  const parentName = nameById(list.data?.items);
  return (
    <RegistryPage<ChartAccount>
      path="/chart-accounts"
      title="Plano de contas"
      subtitle="Contas contábeis usadas para classificar lançamentos."
      noun="conta contábil"
      gender="a"
      fields={FIELDS}
      columns={[
        { key: 'code', header: 'Código', width: '8rem' },
        { key: 'name', header: 'Nome' },
        { key: 'accountType', header: 'Tipo', render: (r) => label(ACCOUNT_TYPE_LABELS, r.accountType) },
        { key: 'parent', header: 'Conta superior', render: (r) => parentName(r.parentId), hideOnMobile: true },
      ]}
    />
  );
}
