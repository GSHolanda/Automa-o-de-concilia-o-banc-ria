import { API_TOKEN_SCOPES } from '@concilia/core/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { DateText } from '../../components/DateText';
import { Field } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { FormModal, SecretModal, useWrite } from '../shared';
import { detailedError } from './comum';

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

const SCOPE_LABELS: Record<string, string> = { 'ledger:write': 'Enviar lançamentos (ledger:write)' };

function tokenStatus(t: ApiToken): { label: string; tone: 'success' | 'neutral' | 'danger' } {
  if (t.revokedAt) return { label: 'Revogado', tone: 'danger' };
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now()) return { label: 'Expirado', tone: 'neutral' };
  return { label: 'Ativo', tone: 'success' };
}

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (token: string) => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['ledger:write']);
  const [expires, setExpires] = useState('');
  const create = useWrite<void, ApiToken & { token: string }>({
    inlineError: true,
    invalidate: [['api-tokens']],
    mutationFn: () =>
      api.post('/api-tokens', {
        name: name.trim(),
        scopes,
        // Validade até o fim do dia escolhido, no horário local.
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
      }),
    onSuccess: (r) => {
      onCreated(r.token);
      onClose();
    },
  });
  return (
    <FormModal
      open
      title="Novo token de API"
      onClose={onClose}
      onSubmit={() => create.mutate()}
      busy={create.isPending}
      submitDisabled={!name.trim() || scopes.length === 0}
      submitLabel="Criar token"
      error={create.errorText ? detailedError(create.error) : null}
    >
      <Field label="Nome" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} hint="Identifica quem usa o token (ex.: ERP financeiro)." />
      <fieldset className="pilha" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend><strong>Escopos</strong></legend>
        {API_TOKEN_SCOPES.map((s) => (
          <Checkbox
            key={s}
            label={SCOPE_LABELS[s] ?? s}
            checked={scopes.includes(s)}
            onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))}
          />
        ))}
      </fieldset>
      <Field label="Validade (opcional)" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} hint="Sem data, o token vale até ser revogado." />
    </FormModal>
  );
}

const CURL = `curl -X POST "$URL_DO_SISTEMA/api/v1/integrations/ledger/entries" \\
  -H "Authorization: Bearer $TOKEN_DE_API" \\
  -H "Idempotency-Key: lote-2025-01-31-001" \\
  -H "Content-Type: application/json" \\
  -d '{
    "entries": [
      {
        "externalId": "LC-1001",
        "date": "2025-01-31",
        "amountCents": -12990,
        "description": "Pagamento de fornecedor",
        "document": "NF-554"
      }
    ]
  }'`;

export function TokensApiPage() {
  const { can, readOnly, hasModule } = useAuth();
  const enabled = hasModule('api.inbound');
  const writable = can('integrations.manage') && !readOnly && enabled;
  const list = useQuery({ queryKey: ['api-tokens'], enabled, queryFn: () => api.get<{ items: ApiToken[] }>('/api-tokens') });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const revoke = useWrite({
    invalidate: [['api-tokens']],
    mutationFn: (t: ApiToken) => api.post(`/api-tokens/${t.id}/revoke`),
    success: 'Token revogado.',
    onSuccess: () => setRevoking(null),
  });

  const columns: Column<ApiToken>[] = [
    { key: 'name', header: 'Nome', render: (t) => <strong>{t.name}</strong> },
    { key: 'prefix', header: 'Prefixo', render: (t) => <code>{t.prefix}…</code> },
    { key: 'scopes', header: 'Escopos', hideOnMobile: true, render: (t) => t.scopes.join(', ') },
    { key: 'exp', header: 'Validade', hideOnMobile: true, render: (t) => (t.expiresAt ? <DateText value={t.expiresAt} withTime /> : 'Sem validade') },
    { key: 'used', header: 'Último uso', hideOnMobile: true, render: (t) => (t.lastUsedAt ? <DateText value={t.lastUsedAt} withTime /> : 'Nunca usado') },
    { key: 'status', header: 'Situação', render: (t) => { const s = tokenStatus(t); return <Badge tone={s.tone}>{s.label}</Badge>; } },
    {
      key: 'acoes',
      header: 'Ações',
      render: (t) =>
        writable && !t.revokedAt ? <Button size="sm" variant="danger" onClick={() => setRevoking(t)}>Revogar<span className="sr-only"> {t.name}</span></Button> : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Tokens de API"
        subtitle="Credenciais para o sistema financeiro enviar lançamentos por API."
        actions={writable && <Button variant="primary" onClick={() => setCreating(true)}>Novo token</Button>}
      />
      {!enabled && (
        <div className="faixa-aviso" role="status">
          O módulo API de lançamentos não está ativo para a empresa. <Link to="/configuracoes/modulos">Ir para Módulos</Link>
        </div>
      )}
      {enabled && (
        <DataTable<ApiToken>
          caption="Tokens de API"
          columns={columns}
          rows={list.data?.items}
          rowKey={(t) => t.id}
          loading={list.isLoading}
          error={list.isError ? errorMessage(list.error) : null}
          onRetry={() => void list.refetch()}
          emptyTitle="Nenhum token criado"
          emptyDescription="Crie um token para que o sistema financeiro envie lançamentos."
        />
      )}
      <section className="cartao pilha" aria-labelledby="ajuda-api" style={{ marginTop: 'var(--e5)' }}>
        <h2 id="ajuda-api" style={{ margin: 0 }}>Como enviar lançamentos</h2>
        <p>
          Envie até 1.000 lançamentos por chamada, com valores em centavos inteiros (entrada positiva, saída negativa). O cabeçalho
          <code> Idempotency-Key</code> evita duplicar o lote se a chamada for repetida; reenviar a mesma chave com o mesmo conteúdo devolve o lote original.
        </p>
        <pre style={{ overflowX: 'auto', margin: 0, padding: 'var(--e3)', background: 'var(--cor-primaria-suave)', borderRadius: 4 }}><code>{CURL}</code></pre>
      </section>
      {creating && <CreateModal onClose={() => setCreating(false)} onCreated={setSecret} />}
      <SecretModal
        secret={secret}
        title="Token de API criado"
        label="Token de API"
        description="Copie o token agora e guarde-o em local seguro."
        footnote="Este token não será exibido novamente. Se for perdido, revogue-o e crie outro."
        onClose={() => setSecret(null)}
      />
      <ConfirmDialog
        open={revoking !== null}
        title="Revogar token"
        message={`Revogar o token ${revoking?.name ?? ''}? Quem o usa perde o acesso imediatamente.`}
        confirmLabel="Revogar"
        destructive
        onConfirm={() => revoking && revoke.mutate(revoking)}
        onCancel={() => setRevoking(null)}
      />
    </>
  );
}
