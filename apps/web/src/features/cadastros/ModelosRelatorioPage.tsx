import { Badge } from '../../components/Badge';
import { RegistryPage, type FieldDef, type RegistryRow } from './RegistryPage';
import { REPORT_KIND_LABELS, label, options } from './rotulos';

interface Template extends RegistryRow {
  name: string;
  kind: string;
  isDefault: boolean;
}

const FIELDS: FieldDef<Template>[] = [
  { key: 'name', label: 'Nome', type: 'text', required: true, maxLength: 120 },
  { key: 'kind', label: 'Tipo', type: 'select', required: true, options: options(REPORT_KIND_LABELS) },
  { key: 'isDefault', label: 'Modelo padrão deste tipo', type: 'checkbox', hint: 'Só um modelo por tipo é padrão; este substitui o anterior.' },
];

export function ModelosRelatorioPage() {
  return (
    <RegistryPage<Template>
      path="/report-templates"
      title="Modelos de relatório"
      subtitle="Modelos usados nas exportações."
      noun="modelo de relatório"
      gender="o"
      hasActive={false}
      fields={FIELDS}
      columns={[
        { key: 'name', header: 'Nome' },
        { key: 'kind', header: 'Tipo', render: (r) => label(REPORT_KIND_LABELS, r.kind) },
        { key: 'isDefault', header: 'Padrão', render: (r) => (r.isDefault ? <Badge tone="info">Padrão</Badge> : '—') },
      ]}
    />
  );
}
