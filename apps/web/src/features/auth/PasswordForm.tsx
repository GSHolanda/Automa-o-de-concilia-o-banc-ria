import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';

/** Troca de senha (POST /auth/password). Chama onDone após sucesso. */
export function PasswordForm({ onDone, disabled = false }: { onDone: () => void | Promise<void>; disabled?: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setErrors({ confirm: 'A confirmação não é igual à nova senha.' });
      return;
    }
    if (next === current) {
      setErrors({ next: 'A nova senha deve ser diferente da atual.' });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.post('/auth/password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      await onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_password') setErrors({ current: err.message });
      else if (err instanceof ApiError && err.status === 400) setErrors({ next: err.message });
      else setErrors({ form: err instanceof Error ? err.message : 'Não foi possível trocar a senha.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="pilha" onSubmit={(e) => void submit(e)} noValidate>
      {errors.form && <p className="campo-erro" role="alert">{errors.form}</p>}
      <Field
        label="Senha atual"
        type="password"
        autoComplete="current-password"
        required
        value={current}
        error={errors.current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <Field
        label="Nova senha"
        type="password"
        autoComplete="new-password"
        required
        value={next}
        error={errors.next}
        onChange={(e) => setNext(e.target.value)}
      />
      <Field
        label="Confirmar nova senha"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        error={errors.confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <Button type="submit" variant="primary" loading={busy} disabled={disabled || !current || !next || !confirm}>
        Trocar senha
      </Button>
    </form>
  );
}
