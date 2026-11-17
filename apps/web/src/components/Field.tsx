import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

export interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  /** Recebe os atributos de acessibilidade para o controle. */
  children: (control: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true; required?: boolean }) => ReactNode;
}

/** Rótulo, dica e mensagem de erro ligados ao controle por id/aria. */
export function FieldShell({ label, hint, error, required, children }: FieldShellProps) {
  const id = useId();
  const hintId = `${id}-dica`;
  const errorId = `${id}-erro`;
  const describedBy = [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="campo">
      <label htmlFor={id} className="campo-rotulo">
        {label}
        {required && <span aria-hidden="true" className="campo-obrigatorio"> *</span>}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined, required })}
      {hint && <p id={hintId} className="campo-dica">{hint}</p>}
      {error && <p id={errorId} className="campo-erro" role="alert">{error}</p>}
    </div>
  );
}

type BaseProps = { label: string; hint?: string; error?: string | null };
export type FieldProps =
  | (BaseProps & { multiline?: false } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>)
  | (BaseProps & { multiline: true } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>);

/** Campo de texto (input ou textarea) com rótulo, dica e erro. */
export function Field(props: FieldProps) {
  const { label, hint, error, multiline, ...rest } = props;
  const required = (rest as { required?: boolean }).required;
  return (
    <FieldShell label={label} hint={hint} error={error} required={required}>
      {(control) =>
        multiline ? (
          <textarea
            rows={4}
            {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
            {...control}
            className="controle"
          />
        ) : (
          <input {...(rest as InputHTMLAttributes<HTMLInputElement>)} {...control} className="controle" />
        )
      }
    </FieldShell>
  );
}
