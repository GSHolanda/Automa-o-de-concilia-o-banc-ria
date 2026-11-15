import { useEffect, useState } from 'react';
import { Field } from '../../components/Field';

export interface NumberFieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  /** Número atual; NaN representa campo vazio ou inválido. */
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | 'any';
  /** Casas decimais ao exibir um valor vindo de fora (padrão: o necessário). */
  decimals?: number;
  disabled?: boolean;
  suffix?: string;
}

const show = (value: number, decimals?: number) =>
  Number.isNaN(value) ? '' : (decimals === undefined ? String(value) : value.toFixed(decimals)).replace('.', ',');

/** Campo numérico com texto livre (aceita vírgula); informa NaN enquanto o texto não for um número. */
export function NumberField({ label, hint, error, value, onChange, min, max, step, decimals, disabled, suffix }: NumberFieldProps) {
  const [text, setText] = useState(() => show(value, decimals));

  // Reflete mudanças externas (recarga, restauração) sem atrapalhar a digitação.
  useEffect(() => {
    const parsed = parse(text);
    if (!(Number.isNaN(parsed) && Number.isNaN(value)) && parsed !== value) setText(show(value, decimals));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <Field
      label={suffix ? `${label} (${suffix})` : label}
      hint={hint}
      error={error}
      inputMode="decimal"
      value={text}
      disabled={disabled}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
    />
  );
}

function parse(text: string): number {
  const clean = text.trim().replace(',', '.');
  if (clean === '' || !/^-?\d+(\.\d+)?$/.test(clean)) return NaN;
  return Number(clean);
}

/** Mensagem de erro para um número fora da faixa; null quando válido. */
export function rangeError(value: number, min: number, max: number, integer = true, unit = ''): string | null {
  if (Number.isNaN(value)) return 'Informe um número.';
  if (integer && !Number.isInteger(value)) return 'Use um número inteiro.';
  if (value < min || value > max) return `Use um valor entre ${min} e ${max}${unit}.`;
  return null;
}
