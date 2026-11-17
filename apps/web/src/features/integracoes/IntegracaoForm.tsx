import { DEFAULT_AI_MODEL, REST_AUTH_TYPES, type IntegrationKind } from '@concilia/core/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Page } from '../../api/client';
import { Checkbox } from '../../components/Checkbox';
import { Field } from '../../components/Field';
import { Select } from '../../components/Select';
import { FormModal, useWrite } from '../shared';
import { detailedError } from './comum';

export interface Integration {
  id: string;
  kind: IntegrationKind;
  name: string;
  config: Record<string, unknown>;
  hasSecret: boolean;
  status: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  active: boolean;
  moduleEnabled?: boolean;
}

export const KIND_INFO: Record<IntegrationKind, { label: string; singular: string; description: string; secretLabel: string; secretHint: string }> = {
  webhook: {
    label: 'Webhook',
    singular: 'webhook',
    description: 'Envia eventos assinados para um endereço da empresa.',
    secretLabel: 'Segredo de assinatura',
    secretHint: 'Usado para assinar cada envio (cabeçalho X-Concilia-Signature). Depois de salvo, não pode mais ser lido.',
  },
  smtp: {
    label: 'E-mail (SMTP)',
    singular: 'servidor SMTP',
    description: 'Envia avisos por e-mail pelo servidor SMTP da empresa.',
    secretLabel: 'Senha do SMTP',
    secretHint: 'Necessária quando o servidor exige usuário. Depois de salva, não pode mais ser lida.',
  },
  rest_ledger: {
    label: 'Conector REST de lançamentos',
    singular: 'conector REST',
    description: 'Busca lançamentos em uma API REST do sistema financeiro.',
    secretLabel: 'Credencial de autenticação',
    secretHint: 'Token ou senha, conforme o tipo de autenticação. Depois de salva, não pode mais ser lida.',
  },
  ai_provider: {
    label: 'Provedor de IA',
    singular: 'provedor de IA',
    description: 'Sugere categorias para transações sem correspondência.',
    secretLabel: 'Chave de API',
    secretHint: 'Chave do provedor. Depois de salva, não pode mais ser lida.',
  },
};

const AUTH_LABELS: Record<string, string> = {
  none: 'Sem autenticação',
  bearer: 'Token (Bearer)',
  header: 'Cabeçalho personalizado',
  basic: 'Usuário e senha (Basic)',
};

const FIELD_MAP_FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: 'date', label: 'Caminho da data', required: true },
  { key: 'amount', label: 'Caminho do valor', required: true },
  { key: 'description', label: 'Caminho da descrição', required: true },
  { key: 'externalId', label: 'Caminho do identificador externo' },
  { key: 'document', label: 'Caminho do documento' },
  { key: 'reference', label: 'Caminho da referência' },
  { key: 'counterparty', label: 'Caminho da contraparte' },
  { key: 'dueDate', label: 'Caminho do vencimento' },
  { key: 'bankAccountRef', label: 'Caminho da conta bancária' },
  { key: 'costCenter', label: 'Caminho do centro de custo' },
  { key: 'category', label: 'Caminho da categoria' },
];

interface State {
  name: string;
  active: boolean;
  secretMode: 'keep' | 'replace' | 'remove';
  secret: string;
  url: string;
  host: string;
  port: string;
  secure: boolean;
  user: string;
  from: string;
  baseUrl: string;
  path: string;
  authType: string;
  headerName: string;
  itemsPath: string;
  dateFromParam: string;
  dateToParam: string;
  amountUnit: string;
  fieldMap: Record<string, string>;
  bankAccountId: string;
  model: string;
  baseURL: string;
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback);

function initialState(item: Integration | null): State {
  const c = item?.config ?? {};
  const map = (c.fieldMap && typeof c.fieldMap === 'object' ? c.fieldMap : {}) as Record<string, unknown>;
  return {
    name: item?.name ?? '',
    active: item?.active ?? true,
    secretMode: 'keep',
    secret: '',
    url: str(c.url),
    host: str(c.host),
    port: str(c.port, '587'),
    secure: c.secure === true,
    user: str(c.user),
    from: str(c.from),
    baseUrl: str(c.baseUrl),
    path: str(c.path, '/'),
    authType: str(c.authType, 'bearer'),
    headerName: str(c.headerName),
    itemsPath: str(c.itemsPath),
    dateFromParam: str(c.dateFromParam, 'dateFrom'),
    dateToParam: str(c.dateToParam, 'dateTo'),
    amountUnit: str(c.amountUnit, 'decimal'),
    fieldMap: Object.fromEntries(FIELD_MAP_FIELDS.map((f) => [f.key, str(map[f.key])])),
    bankAccountId: str(c.bankAccountId),
    model: str(c.model, DEFAULT_AI_MODEL),
    baseURL: str(c.baseURL),
  };
}

function buildConfig(kind: IntegrationKind, s: State): Record<string, unknown> {
  switch (kind) {
    case 'webhook':
      return { url: s.url.trim() };
    case 'smtp':
      return { host: s.host.trim(), port: Number(s.port), secure: s.secure, user: s.user.trim() || null, from: s.from.trim() };
    case 'rest_ledger': {
      const fieldMap: Record<string, string> = {};
      for (const f of FIELD_MAP_FIELDS) {
        const v = (s.fieldMap[f.key] ?? '').trim();
        if (v) fieldMap[f.key] = v;
      }
      return {
        baseUrl: s.baseUrl.trim(),
        path: s.path.trim() || '/',
        authType: s.authType,
        headerName: s.authType === 'header' || s.authType === 'basic' ? s.headerName.trim() || null : null,
        itemsPath: s.itemsPath.trim() || null,
        dateFromParam: s.dateFromParam.trim(),
        dateToParam: s.dateToParam.trim(),
        amountUnit: s.amountUnit,
        fieldMap,
        bankAccountId: s.bankAccountId || null,
      };
    }
    case 'ai_provider':
      return { provider: 'anthropic', model: s.model.trim(), baseURL: s.baseURL.trim() || null };
  }
}

/** Texto do que falta preencher (vazio quando o formulário pode ser enviado). */
function missing(kind: IntegrationKind, s: State): string {
  if (!s.name.trim()) return 'Informe o nome.';
  if (kind === 'webhook' && !s.url.trim()) return 'Informe o endereço.';
  if (kind === 'smtp' && (!s.host.trim() || !s.from.trim() || !Number(s.port))) return 'Informe servidor, porta e remetente.';
  if (kind === 'rest_ledger') {
    if (!s.baseUrl.trim()) return 'Informe o endereço base.';
    if ((s.authType === 'header' || s.authType === 'basic') && !s.headerName.trim()) return 'Informe o nome do cabeçalho ou usuário.';
    if (!s.dateFromParam.trim() || !s.dateToParam.trim()) return 'Informe os parâmetros de período.';
    if (FIELD_MAP_FIELDS.some((f) => f.required && !(s.fieldMap[f.key] ?? '').trim())) return 'Informe os caminhos de data, valor e descrição.';
  }
  if (kind === 'ai_provider' && !s.model.trim()) return 'Informe o modelo.';
  return '';
}

export function IntegracaoForm({ kind, item, onClose }: { kind: IntegrationKind; item: Integration | null; onClose: () => void }) {
  const [s, setS] = useState<State>(() => initialState(item));
  const set = <K extends keyof State>(key: K, value: State[K]) => setS((prev) => ({ ...prev, [key]: value }));
  const info = KIND_INFO[kind];
  const accounts = useQuery({
    queryKey: ['/bank-accounts', 'options'],
    enabled: kind === 'rest_ledger',
    staleTime: 60_000,
    queryFn: () => api.get<Page<{ id: string; name: string }>>('/bank-accounts', { limit: 200 }),
  });

  const save = useWrite<void, Integration>({
    inlineError: true,
    invalidate: [['integrations']],
    success: item ? 'Integração salva.' : 'Integração cadastrada.',
    onSuccess: onClose,
    mutationFn: () => {
      const config = buildConfig(kind, s);
      if (!item) {
        return api.post<Integration>('/integrations', { kind, name: s.name.trim(), config, active: s.active, ...(s.secret ? { secret: s.secret } : {}) });
      }
      const body: Record<string, unknown> = { name: s.name.trim(), active: s.active };
      // Só reenvia a configuração se mudou: alterar config ou segredo exige novo teste.
      if (JSON.stringify(config) !== JSON.stringify(buildConfig(kind, initialState(item)))) body.config = config;
      if (s.secretMode === 'remove') body.secret = null;
      else if (s.secretMode === 'replace' && s.secret) body.secret = s.secret;
      return api.patch<Integration>(`/integrations/${item.id}`, body);
    },
  });

  const problem = missing(kind, s) || (item && s.secretMode === 'replace' && !s.secret ? 'Informe o novo segredo ou escolha manter.' : '');
  const secretNeeded =
    kind === 'webhook' || kind === 'ai_provider' || (kind === 'rest_ledger' && s.authType !== 'none') || (kind === 'smtp' && !!s.user.trim());

  return (
    <FormModal
      open
      size="lg"
      title={item ? `Editar ${info.singular}` : `Nova integração: ${info.label}`}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      busy={save.isPending}
      submitDisabled={!!problem}
      error={save.errorText ? detailedError(save.error) : null}
    >
      <Field label="Nome" required value={s.name} maxLength={120} onChange={(e) => set('name', e.target.value)} />

      {kind === 'webhook' && (
        <Field label="Endereço do webhook" required type="url" placeholder="https://exemplo.com.br/hook" value={s.url} onChange={(e) => set('url', e.target.value)} hint="Endereço http(s) que receberá os eventos." />
      )}

      {kind === 'smtp' && (
        <>
          <div className="grade-2">
            <Field label="Servidor SMTP" required value={s.host} onChange={(e) => set('host', e.target.value)} />
            <Field label="Porta" required type="number" min={1} max={65535} value={s.port} onChange={(e) => set('port', e.target.value)} />
            <Field label="Usuário" value={s.user} onChange={(e) => set('user', e.target.value)} hint="Deixe vazio se o servidor não exige autenticação." />
            <Field label="Remetente" required type="email" value={s.from} onChange={(e) => set('from', e.target.value)} />
          </div>
          <Checkbox label="Conexão segura (TLS direto)" checked={s.secure} onChange={(e) => set('secure', e.target.checked)} />
        </>
      )}

      {kind === 'rest_ledger' && (
        <>
          <div className="grade-2">
            <Field label="Endereço base" required type="url" placeholder="https://api.exemplo.com.br" value={s.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
            <Field label="Caminho" value={s.path} onChange={(e) => set('path', e.target.value)} hint="Ex.: /lancamentos" />
            <Select
              label="Autenticação"
              value={s.authType}
              onChange={(e) => set('authType', e.target.value)}
              options={REST_AUTH_TYPES.map((t) => ({ value: t, label: AUTH_LABELS[t] ?? t }))}
            />
            {(s.authType === 'header' || s.authType === 'basic') && (
              <Field
                label={s.authType === 'basic' ? 'Usuário da autenticação básica' : 'Nome do cabeçalho de autenticação'}
                required
                value={s.headerName}
                onChange={(e) => set('headerName', e.target.value)}
              />
            )}
            <Field label="Caminho da lista na resposta" value={s.itemsPath} onChange={(e) => set('itemsPath', e.target.value)} hint="Ex.: data.items. Vazio quando a resposta já é a lista." />
            <Select
              label="Unidade do valor"
              value={s.amountUnit}
              onChange={(e) => set('amountUnit', e.target.value)}
              options={[{ value: 'decimal', label: 'Decimal (reais)' }, { value: 'cents', label: 'Centavos inteiros' }]}
            />
            <Field label="Parâmetro de início do período" required value={s.dateFromParam} onChange={(e) => set('dateFromParam', e.target.value)} />
            <Field label="Parâmetro de fim do período" required value={s.dateToParam} onChange={(e) => set('dateToParam', e.target.value)} />
            <Select
              label="Conta bancária padrão"
              placeholder="Nenhuma"
              value={s.bankAccountId}
              onChange={(e) => set('bankAccountId', e.target.value)}
              options={(accounts.data?.items ?? []).map((a) => ({ value: a.id, label: a.name }))}
            />
          </div>
          <fieldset className="pilha" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend><strong>Mapa de campos</strong></legend>
            <p className="texto-suave">Caminho, com pontos, de cada campo no item devolvido pela API (ex.: <code>valor.total</code>).</p>
            <div className="grade-2">
              {FIELD_MAP_FIELDS.map((f) => (
                <Field
                  key={f.key}
                  label={f.label}
                  required={f.required}
                  value={s.fieldMap[f.key] ?? ''}
                  onChange={(e) => set('fieldMap', { ...s.fieldMap, [f.key]: e.target.value })}
                />
              ))}
            </div>
          </fieldset>
        </>
      )}

      {kind === 'ai_provider' && (
        <>
          <div className="grade-2">
            <Select label="Provedor" value="anthropic" onChange={() => undefined} options={[{ value: 'anthropic', label: 'Anthropic' }]} />
            <Field label="Modelo" required value={s.model} onChange={(e) => set('model', e.target.value)} />
          </div>
          <Field label="Endereço alternativo da API" type="url" value={s.baseURL} onChange={(e) => set('baseURL', e.target.value)} hint="Opcional. Deixe vazio para usar o endereço padrão do provedor." />
          <p className="texto-suave">
            As sugestões da IA sempre passam por aceite humano. Ao provedor são enviados apenas a descrição normalizada, o sinal (entrada ou saída) e o tipo da
            transação, além dos nomes das categorias.
          </p>
        </>
      )}

      <fieldset className="pilha" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend><strong>{info.secretLabel}</strong>{secretNeeded ? ' (necessário)' : ' (opcional)'}</legend>
        {item?.hasSecret && (
          <>
            <p><span className="badge badge-success">Configurado</span> O valor atual não pode ser exibido.</p>
            <Select
              label="Segredo"
              value={s.secretMode}
              onChange={(e) => set('secretMode', e.target.value as State['secretMode'])}
              options={[
                { value: 'keep', label: 'Manter o segredo atual' },
                { value: 'replace', label: 'Substituir por um novo' },
                { value: 'remove', label: 'Remover o segredo' },
              ]}
            />
          </>
        )}
        {(!item?.hasSecret || s.secretMode === 'replace') && (
          <Field
            label={item?.hasSecret ? `Novo valor de: ${info.secretLabel.toLowerCase()}` : info.secretLabel}
            type="password"
            autoComplete="new-password"
            value={s.secret}
            onChange={(e) => set('secret', e.target.value)}
            hint={info.secretHint}
          />
        )}
        {s.secretMode === 'remove' && item?.hasSecret && <p className="texto-suave">O segredo será apagado ao salvar.</p>}
      </fieldset>

      <Checkbox label="Integração ativa" checked={s.active} onChange={(e) => set('active', e.target.checked)} />
      {item && <p className="texto-suave">Alterar a configuração ou o segredo zera a situação: será preciso testar a conexão de novo.</p>}
    </FormModal>
  );
}
