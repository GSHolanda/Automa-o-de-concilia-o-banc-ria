import { useId, useRef, useState, type DragEvent } from 'react';

export interface FileDropProps {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  hint?: string;
  /** Tamanho máximo por arquivo, em MB; excedentes geram `onReject`. */
  maxSizeMb?: number;
  onReject?: (message: string) => void;
}

/** Área de seleção de arquivos (clique, teclado ou arrastar e soltar). */
export function FileDrop({
  onFiles,
  accept,
  multiple = false,
  disabled = false,
  label = 'Selecionar arquivo',
  hint,
  maxSizeMb,
  onReject,
}: FileDropProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function handle(list: FileList | null) {
    if (!list || list.length === 0) return;
    let files = Array.from(list);
    if (!multiple) files = files.slice(0, 1);
    if (maxSizeMb) {
      const max = maxSizeMb * 1024 * 1024;
      const big = files.find((f) => f.size > max);
      if (big) {
        onReject?.(`"${big.name}" excede o limite de ${maxSizeMb} MB.`);
        return;
      }
    }
    onFiles(files);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (!disabled) handle(e.dataTransfer.files);
  }

  return (
    <div
      className={`filedrop ${over ? 'filedrop-sobre' : ''} ${disabled ? 'filedrop-off' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input
        ref={input}
        id={id}
        type="file"
        className="sr-only"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          handle(e.target.files);
          e.target.value = '';
        }}
      />
      <label htmlFor={id} className="filedrop-rotulo">
        <strong>{label}</strong>
        <span className="texto-suave">ou arraste e solte aqui</span>
        {hint && <span className="campo-dica">{hint}</span>}
      </label>
    </div>
  );
}
