import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Botões de ação (rodapé). */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** false impede fechar por Esc ou clique fora (ex.: durante um envio). Padrão true. */
  dismissible?: boolean;
}

/** Diálogo modal sobre <dialog>: foco preso, Esc fecha, foco volta ao elemento de origem. */
export function Modal({ open, title, onClose, children, footer, size = 'md', dismissible = true }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={`modal modal-${size}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onMouseDown={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
    >
      <div className="modal-corpo">
        <header className="modal-topo">
          <h2 id={titleId}>{title}</h2>
          {dismissible && (
            <button type="button" className="icone-btn" onClick={onClose} aria-label="Fechar">
              <span aria-hidden="true">×</span>
            </button>
          )}
        </header>
        <div className="modal-conteudo">{children}</div>
        {footer && <footer className="modal-rodape">{footer}</footer>}
      </div>
    </dialog>
  );
}
