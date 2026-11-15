import { useState } from 'react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';

export interface SecretModalProps {
  /** Segredo a exibir; null fecha o modal e descarta o valor. */
  secret: string | null;
  title: string;
  description: string;
  label?: string;
  onClose: () => void;
}

/** Exibe uma credencial gerada uma única vez, com botão de copiar. Não fecha por Esc nem clique fora. */
export function SecretModal({ secret, title, description, label = 'Senha temporária', onClose }: SecretModalProps) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast.success('Copiado.');
    } catch {
      toast.error('Não foi possível copiar. Selecione o texto e copie manualmente.');
    }
  }

  return (
    <Modal
      open={secret !== null}
      title={title}
      size="sm"
      dismissible={false}
      onClose={() => {
        setCopied(false);
        onClose();
      }}
      footer={
        <>
          <Button onClick={() => void copy()}>{copied ? 'Copiado' : 'Copiar'}</Button>
          <Button
            variant="primary"
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            Fechar
          </Button>
        </>
      }
    >
      <p>{description}</p>
      <p className="texto-suave" style={{ margin: 'var(--e2) 0' }}>{label}</p>
      <code
        style={{ display: 'block', padding: 'var(--e3)', background: 'var(--cor-primaria-suave)', borderRadius: 4, fontSize: '1.1rem', wordBreak: 'break-all', userSelect: 'all' }}
      >
        {secret}
      </code>
      <p className="texto-suave" style={{ marginTop: 'var(--e3)' }}>
        Esta senha não será exibida novamente. Quem a receber deverá trocá-la no primeiro acesso.
      </p>
    </Modal>
  );
}
