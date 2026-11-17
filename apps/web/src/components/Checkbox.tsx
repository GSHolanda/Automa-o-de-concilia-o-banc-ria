import { useId, type InputHTMLAttributes } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  label: string;
  hint?: string;
}

export function Checkbox({ label, hint, ...rest }: CheckboxProps) {
  const id = useId();
  return (
    <div className="checkbox">
      <input {...rest} id={id} type="checkbox" aria-describedby={hint ? `${id}-dica` : undefined} />
      <label htmlFor={id}>
        {label}
        {hint && <span id={`${id}-dica`} className="campo-dica">{hint}</span>}
      </label>
    </div>
  );
}
