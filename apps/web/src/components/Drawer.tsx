import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Lado de abertura. Padrão: right. */
  side?: 'right' | 'left';
  width?: 'md' | 'lg' | 'xl';
}

/** Gaveta lateral (detalhes) sobre <dialog> modal; no celular ocupa a tela toda. */
export function Drawer({ open, title, onClose, children, footer, side = 'right', width = 'lg' }: DrawerProps) {
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
      className={`drawer drawer-${side} drawer-${width}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="drawer-corpo">
        <header className="modal-topo">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icone-btn" onClick={onClose} aria-label="Fechar">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="drawer-conteudo">{children}</div>
        {footer && <footer className="modal-rodape">{footer}</footer>}
      </div>
    </dialog>
  );
}
