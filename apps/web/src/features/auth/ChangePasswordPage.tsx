import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { AuthLayout } from './AuthLayout';
import { PasswordForm } from './PasswordForm';

/** Tela obrigatória enquanto user.mustChangePassword for verdadeiro. */
export function ChangePasswordPage() {
  const { me, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const forced = me?.user.mustChangePassword ?? false;

  return (
    <AuthLayout title="Trocar senha">
      <div className="pilha">
        {forced && (
          <p className="texto-suave">Sua senha é temporária. Defina uma nova senha para continuar.</p>
        )}
        <PasswordForm
          onDone={async () => {
            toast.success('Senha alterada com sucesso.');
            await refresh();
            navigate('/', { replace: true });
          }}
        />
        <div className="linha">
          {!forced && <Button variant="ghost" onClick={() => navigate(-1)}>Voltar</Button>}
          <Button variant="ghost" onClick={() => void logout()}>Sair</Button>
        </div>
      </div>
    </AuthLayout>
  );
}
