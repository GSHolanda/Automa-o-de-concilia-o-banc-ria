import { useId, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';

export interface FormModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
  submitLabel?: string;
  busy?: boolean;
  submitDisabled?: boolean;
  /** Mensagem de erro da API, exibida acima dos botões. */
  error?: string | null;
  size?: 'sm' | 'md' | 'lg';
}

/** Modal de formulário: Enter envia, botões de cancelar/salvar, erro da API e bloqueio durante o envio. */
export function FormModal({
  open, title, onClose, onSubmit, children, submitLabel = 'Salvar', busy, submitDisabled, error, size = 'md',
}: FormModalProps) {
  const formId = useId();
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size={size}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" form={formId} variant="primary" loading={busy} disabled={submitDisabled}>{submitLabel}</Button>
        </>
      }
    >
      <form
        id={formId}
        className="pilha"
        noValidate={false}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!busy) onSubmit();
        }}
      >
        {children}
        {error && <p className="campo-erro" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
