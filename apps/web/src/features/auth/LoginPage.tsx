import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { AuthLayout } from './AuthLayout';

export function LoginPage() {
  const { me, status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const from = (location.state as { from?: string } | null)?.from;

  if (status === 'authenticated' && me) {
    return <Navigate to={me.user.mustChangePassword ? '/trocar-senha' : (from ?? '/')} replace />;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(email.trim(), password);
      navigate(result.user.mustChangePassword ? '/trocar-senha' : (from ?? '/'), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar. Tente novamente.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Entrar">
      <form className="pilha" onSubmit={(e) => void submit(e)} noValidate>
        {error && <p className="campo-erro" role="alert">{error}</p>}
        <Field
          label="E-mail"
          type="email"
          autoComplete="username"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Senha"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!email || !password}>
          Entrar
        </Button>
      </form>
    </AuthLayout>
  );
}
