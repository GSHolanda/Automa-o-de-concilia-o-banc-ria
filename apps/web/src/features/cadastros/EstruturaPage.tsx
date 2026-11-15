import { useState } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';
import { RegistryPage, useRegistryList, type FieldDef, type RegistryRow } from './RegistryPage';
import { nameById, parentOptions } from './hierarquia';
import { type OrgKind } from './rotulos';

interface OrgNode extends RegistryRow {
  kind: OrgKind;
  code: string;
  name: string;
  parentId: string | null;
}

const TABS: { key: OrgKind; label: string; noun: string; gender: 'o' | 'a'; plural: string }[] = [
  { key: 'unit', label: 'Unidades', noun: 'unidade', gender: 'a', plural: 'Unidades' },
  { key: 'department', label: 'Departamentos', noun: 'departamento', gender: 'o', plural: 'Departamentos' },
  { key: 'cost_center', label: 'Centros de custo', noun: 'centro de custo', gender: 'o', plural: 'Centros de custo' },
];

const FIELDS: FieldDef<OrgNode>[] = [
  { key: 'code', label: 'Código', type: 'text', required: true, maxLength: 40 },
  { key: 'name', label: 'Nome', type: 'text', required: true, maxLength: 120 },
  { key: 'parentId', label: 'Superior', type: 'select', nullable: true, options: parentOptions, placeholder: 'Nenhum (nível raiz)' },
  { key: 'active', label: 'Ativo', type: 'checkbox', defaultValue: true },
];

function Aba({ kind }: { kind: (typeof TABS)[number] }) {
  const list = useRegistryList<OrgNode>('/org-nodes', { kind: kind.key });
  const parentName = nameById(list.data?.items);
  return (
    <RegistryPage<OrgNode>
      embedded
      path="/org-nodes"
      query={{ kind: kind.key }}
      fixed={{ kind: kind.key }}
      title={kind.plural}
      noun={kind.noun}
      gender={kind.gender}
      fields={FIELDS}
      hasActive
      columns={[
        { key: 'code', header: 'Código', width: '8rem' },
        { key: 'name', header: 'Nome' },
        { key: 'parent', header: 'Superior', render: (r) => parentName(r.parentId), hideOnMobile: true },
      ]}
    />
  );
}

export function EstruturaPage() {
  const [tab, setTab] = useState<OrgKind>('unit');
  const current = TABS.find((t) => t.key === tab) ?? TABS[0]!;
  return (
    <>
      <PageHeader title="Estrutura" subtitle="Unidades, departamentos e centros de custo da empresa." />
      <Tabs label="Tipo de estrutura" tabs={TABS.map((t) => ({ key: t.key, label: t.label }))} value={tab} onChange={(k) => setTab(k as OrgKind)} />
      <Aba key={current.key} kind={current} />
    </>
  );
}
