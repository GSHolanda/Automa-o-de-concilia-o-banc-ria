import type { SelectOption } from '../../components/Select';
import type { OptionsContext } from './RegistryPage';

interface Coded {
  id: string;
  code: string;
  name: string;
}

/** Opções de "pai": os demais registros da lista (nunca o próprio). O servidor recusa ciclos. */
export function parentOptions<T extends Coded>({ rows, editing }: OptionsContext<T>): SelectOption[] {
  return rows.filter((r) => r.id !== editing?.id).map((r) => ({ value: r.id, label: `${r.code} — ${r.name}` }));
}

export function nameById<T extends Coded>(rows: T[] | undefined): (id: string | null | undefined) => string {
  const map = new Map((rows ?? []).map((r) => [r.id, `${r.code} — ${r.name}`]));
  return (id) => (id ? (map.get(id) ?? '—') : '—');
}
