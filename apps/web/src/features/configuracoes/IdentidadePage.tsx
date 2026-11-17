import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Field, FieldShell } from '../../components/Field';
import { FileDrop } from '../../components/FileDrop';
import { PageHeader } from '../../components/PageHeader';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { COR_PADRAO } from '../../theme';
import { useWrite } from '../shared';

interface SettingsResponse {
  version: number;
  settings: { branding: { primaryColor: string; logoDataUrl: string | null } };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_LOGO_BYTES = 200 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

export function IdentidadePage() {
  const { can, readOnly, refresh } = useAuth();
  const toast = useToast();
  const writable = can('settings.manage') && !readOnly;
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings') });
  const [color, setColor] = useState(COR_PADRAO);
  const [logo, setLogo] = useState<string | null>(null);

  const saved = settings.data?.settings.branding;
  useEffect(() => {
    if (!saved) return;
    setColor(saved.primaryColor);
    setLogo(saved.logoDataUrl);
  }, [saved]);

  const save = useWrite({
    inlineError: true,
    invalidate: [['settings']],
    mutationFn: () =>
      api.put('/settings', {
        patch: { branding: { primaryColor: color, logoDataUrl: logo } },
        version: settings.data?.version,
      }),
    success: 'Identidade visual salva.',
    onSuccess: () => void refresh(),
  });

  async function pick(files: File[]) {
    const file = files[0];
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) return toast.error('Use uma imagem PNG, JPEG ou WebP.');
    if (file.size > MAX_LOGO_BYTES) return toast.error('O logotipo deve ter no máximo 200 KB.');
    try {
      setLogo(await readAsDataUrl(file));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível ler o arquivo.');
    }
  }

  const validColor = HEX.test(color);
  const dirty = saved !== undefined && (color !== saved.primaryColor || logo !== saved.logoDataUrl);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (validColor) save.mutate();
  }

  return (
    <>
      <PageHeader title="Identidade visual" subtitle="Cor principal e logotipo, aplicados a toda a interface da empresa." />
      {settings.isLoading && <Spinner label="Carregando identidade visual" />}
      {settings.isError && (
        <EmptyState
          tone="error"
          title="Não foi possível carregar a identidade visual"
          description={errorMessage(settings.error)}
          action={<Button onClick={() => void settings.refetch()}>Tentar novamente</Button>}
        />
      )}
      {saved && (
        <form className="cartao pilha" style={{ maxWidth: 560 }} onSubmit={submit}>
          <FieldShell label="Cor principal" hint="Escolha no seletor ou digite o código hexadecimal (#RRGGBB)." error={validColor ? null : 'Use o formato #RRGGBB.'}>
            {(control) => (
              <div className="linha">
                <input
                  type="color"
                  aria-label="Seletor de cor"
                  value={validColor ? color.toLowerCase() : COR_PADRAO}
                  disabled={!writable}
                  onChange={(e) => setColor(e.target.value)}
                  style={{ width: 56, height: 40, padding: 2 }}
                />
                <input
                  {...control}
                  className="controle"
                  style={{ width: '9rem' }}
                  value={color}
                  maxLength={7}
                  disabled={!writable}
                  onChange={(e) => setColor(e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`)}
                />
                <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 4, border: '1px solid var(--cor-borda)', background: validColor ? color : 'transparent' }} />
              </div>
            )}
          </FieldShell>

          <div className="pilha" style={{ gap: 'var(--e2)' }}>
            <strong>Logotipo</strong>
            {logo ? (
              <div className="linha">
                <img src={logo} alt="Pré-visualização do logotipo" style={{ maxHeight: 72, maxWidth: 240, objectFit: 'contain', border: '1px solid var(--cor-borda)', borderRadius: 4, padding: 'var(--e2)' }} />
                <Button disabled={!writable} onClick={() => setLogo(null)}>Remover logotipo</Button>
              </div>
            ) : (
              <p className="texto-suave">Nenhum logotipo definido.</p>
            )}
            <FileDrop
              accept="image/png,image/jpeg,image/webp"
              label={logo ? 'Trocar logotipo' : 'Selecionar logotipo'}
              hint="PNG, JPEG ou WebP, até 200 KB."
              disabled={!writable}
              onFiles={(f) => void pick(f)}
              onReject={(m) => toast.error(m)}
              maxSizeMb={0.2}
            />
          </div>

          {save.errorText && <p className="campo-erro" role="alert">{save.errorText}</p>}
          <div className="linha">
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!writable || !validColor || !dirty}>
              Salvar
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
