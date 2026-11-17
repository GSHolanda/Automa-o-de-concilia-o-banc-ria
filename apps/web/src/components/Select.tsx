import type { SelectHTMLAttributes } from 'react';
import { FieldShell } from './Field';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  options: SelectOption[];
  hint?: string;
  error?: string | null;
  /** Texto da opção vazia (valor ""). Omita para não exibir. */
  placeholder?: string;
}

export function Select({ label, options, hint, error, placeholder, ...rest }: SelectProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={rest.required}>
      {(control) => (
        <select {...rest} {...control} className="controle">
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}
