import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { TenantSettings, TenantSettingsPatch } from '@concilia/core/shared';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { api, ApiError, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Spinner } from '../../components/Spinner';
import { useWrite } from '../shared';

export interface StoredSettings {
  settings: TenantSettings;
  version: number;
}

export const SETTINGS_KEY = ['settings'] as const;

export function useSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api.get<StoredSettings>('/settings') });
}

/** Escrita liberada: permissão de gerir configurações e licença não está em somente leitura. */
export function useCanWrite(): boolean {
  const { can, readOnly } = useAuth();
  return can('settings.manage') && !readOnly;
}

/** Carrega as configurações e mostra carregamento/erro; `children` recebe os dados. Remonta a cada versão nova. */
export function SettingsGate({ query, children }: { query: UseQueryResult<StoredSettings>; children: (data: StoredSettings) => ReactNode }) {
  if (query.isLoading) return <Spinner label="Carregando configurações" />;
  if (query.isError || !query.data) {
    return (
      <EmptyState
        tone="error"
        title="Não foi possível carregar as configurações"
        description={errorMessage(query.error)}
        action={<Button onClick={() => void query.refetch()}>Tentar de novo</Button>}
      />
    );
  }
  return <>{children(query.data)}</>;
}

/** Barra de gravação: botão salvar, aviso de somente leitura e tratamento de versão desatualizada (409). */
export function SettingsSaveBar({
  version,
  buildPatch,
  invalid,
  disabled,
  onReload,
}: {
  version: number;
  buildPatch: () => TenantSettingsPatch;
  invalid: boolean;
  disabled: boolean;
  onReload: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const save = useWrite<void, StoredSettings>({
    inlineError: true,
    invalidate: [SETTINGS_KEY],
    success: 'Configurações salvas.',
    mutationFn: () => api.put<StoredSettings>('/settings', { patch: buildPatch(), version }),
    onSuccess: () => setSaved(true),
  });
  const stale = save.error instanceof ApiError && save.error.code === 'stale_version';
  return (
    <div className="pilha" style={{ gap: 'var(--e3)' }}>
      {save.errorText && (
        <div className="erro-texto" role="alert">
          {stale
            ? 'Estas configurações foram alteradas por outra pessoa depois que você abriu a tela. Recarregue para ver os valores atuais; suas edições não salvas serão descartadas.'
            : save.errorText}
          {stale && (
            <div style={{ marginTop: 'var(--e2)' }}>
              <Button onClick={onReload}>Recarregar configurações</Button>
            </div>
          )}
        </div>
      )}
      {saved && !save.errorText && !save.isPending && <p className="texto-suave" role="status">Alterações salvas.</p>}
      {!disabled && (
        <div className="linha">
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={invalid || stale}
            onClick={() => {
              setSaved(false);
              save.mutate();
            }}
          >
            Salvar alterações
          </Button>
          {invalid && <span className="texto-suave">Corrija os campos destacados para salvar.</span>}
        </div>
      )}
      {disabled && <p className="texto-suave">Somente leitura: você não pode alterar estas configurações agora.</p>}
    </div>
  );
}

/** Agrupa campos de um formulário de configuração e desabilita todos de uma vez. */
export function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="cartao pilha" style={{ gap: 'var(--e4)' }}>
      <div>
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>{title}</h2>
        {description && <p className="texto-suave" style={{ margin: 'var(--e1) 0 0' }}>{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function LockedFieldset({ locked, children }: { locked: boolean; children: ReactNode }) {
  return (
    <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} className="pilha">
      {children}
    </fieldset>
  );
}

export const FIELD_GRID: CSSProperties = { display: 'grid', gap: 'var(--e4)', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', alignItems: 'start' };
