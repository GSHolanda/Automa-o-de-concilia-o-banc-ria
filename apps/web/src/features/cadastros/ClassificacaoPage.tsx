import { ITEM_KIND_LABELS, type ItemKind } from '@concilia/core/shared';
import { RegistryPage, useRegistryList, type FieldDef, type RegistryRow } from './RegistryPage';
import { nameById } from './hierarquia';
import { APPLIES_TO_LABELS, DIRECTION_LABELS, ITEM_KIND_OPTIONS, MATCH_TYPE_LABELS, MATCH_TYPE_OPTIONS, label, options } from './rotulos';
import type { Category } from './CategoriasPage';

interface Rule extends RegistryRow {
  name: string;
  priority: number;
  matchType: string;
  pattern: string;
  appliesTo: string;
  direction: string;
  resultKind: ItemKind;
  categoryId: string | null;
}

export function ClassificacaoPage() {
  const categories = useRegistryList<Category>('/categories');
  const categoryName = nameById(categories.data?.items);
  const fields: FieldDef<Rule>[] = [
    { key: 'name', label: 'Nome', type: 'text', required: true, maxLength: 120 },
    { key: 'priority', label: 'Prioridade', type: 'number', min: 0, max: 10000, defaultValue: 100, hint: 'Menor número é avaliado primeiro.' },
    { key: 'matchType', label: 'Tipo de comparação', type: 'select', required: true, options: MATCH_TYPE_OPTIONS, defaultValue: 'contains' },
    { key: 'pattern', label: 'Texto', type: 'text', required: true, maxLength: 200, hint: 'Comparado com a descrição normalizada, sem diferenciar maiúsculas e acentos.' },
    { key: 'appliesTo', label: 'Lado', type: 'select', required: true, options: options(APPLIES_TO_LABELS), defaultValue: 'both' },
    { key: 'direction', label: 'Direção', type: 'select', required: true, options: options(DIRECTION_LABELS), defaultValue: 'any' },
    { key: 'resultKind', label: 'Tipo resultante', type: 'select', required: true, options: ITEM_KIND_OPTIONS },
    {
      key: 'categoryId',
      label: 'Categoria',
      type: 'select',
      nullable: true,
      options: (categories.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` })),
    },
    { key: 'active', label: 'Ativa', type: 'checkbox', defaultValue: true },
  ];
  return (
    <RegistryPage<Rule>
      path="/classification-rules"
      title="Classificação"
      subtitle="Regras por texto que identificam tarifas, impostos, juros, estornos e transferências. A primeira regra ativa que casar, por prioridade, vale."
      noun="regra de classificação"
      gender="a"
      fields={fields}
      columns={[
        { key: 'priority', header: 'Prioridade', align: 'right', width: '6rem' },
        { key: 'name', header: 'Nome' },
        { key: 'match', header: 'Comparação', render: (r) => `${label(MATCH_TYPE_LABELS, r.matchType)}: ${r.pattern}`, hideOnMobile: true },
        { key: 'applies', header: 'Lado / direção', render: (r) => `${label(APPLIES_TO_LABELS, r.appliesTo)} · ${label(DIRECTION_LABELS, r.direction)}`, hideOnMobile: true },
        { key: 'kind', header: 'Resultado', render: (r) => ITEM_KIND_LABELS[r.resultKind] ?? r.resultKind },
        { key: 'cat', header: 'Categoria', render: (r) => categoryName(r.categoryId), hideOnMobile: true },
      ]}
    />
  );
}
