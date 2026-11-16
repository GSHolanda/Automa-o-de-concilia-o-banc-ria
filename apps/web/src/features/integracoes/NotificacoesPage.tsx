import {
  INTEGRATION_MODULES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_LABELS,
  type NotificationChannel,
  type NotificationEvent,
} from '@concilia/core/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, type Page } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge, type BadgeTone } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { DateText } from '../../components/DateText';
import { Field } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { Select } from '../../components/Select';
import { Tabs } from '../../components/Tabs';
import { FormModal, useWrite } from '../shared';
import { detailedError } from './comum';
import type { Integration } from './IntegracaoForm';

interface Rule {
  id: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  target: { roleKeys?: string[]; emails?: string[] };
  integrationId: string | null;
  active: boolean;
}

interface Delivery {
  id: string;
  channel: string;
  event: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

const CHANNEL_LABELS: Record<NotificationChannel, string> = { in_app: 'Aviso interno', email: 'E-mail', webhook: 'Webhook' };
const CHANNEL_MODULE = { email: INTEGRATION_MODULES.smtp, webhook: INTEGRATION_MODULES.webhook } as const;
const CHANNEL_KIND = { email: 'smtp', webhook: 'webhook' } as const;
const DELIVERY_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pendente', tone: 'warning' },
  sent: { label: 'Enviada', tone: 'success' },
  failed: { label: 'Falhou', tone: 'danger' },
  skipped: { label: 'Ignorada', tone: 'neutral' },
};
const eventLabel = (e: string) => NOTIFICATION_EVENT_LABELS[e as NotificationEvent] ?? e;

function targetText(r: Rule, roleNames: Map<string, string>): string {
  if (r.channel === 'in_app') return (r.target.roleKeys ?? []).map((k) => roleNames.get(k) ?? k).join(', ') || '—';
  if (r.channel === 'email') return (r.target.emails ?? []).join(', ') || '—';
  return 'Endereço da integração';
}

function RuleForm({ rule, onClose, roles }: { rule: Rule | null; onClose: () => void; roles: { key: string; name: string }[] | null }) {
  const { hasModule, can } = useAuth();
  const [event, setEvent] = useState<string>(rule?.event ?? 'approval.requested');
  const [channel, setChannel] = useState<NotificationChannel>(rule?.channel ?? 'in_app');
  const [roleKeys, setRoleKeys] = useState<string[]>(rule?.target.roleKeys ?? []);
  const [roleText, setRoleText] = useState((rule?.target.roleKeys ?? []).join(', '));
  const [emails, setEmails] = useState((rule?.target.emails ?? []).join('\n'));
  const [integrationId, setIntegrationId] = useState(rule?.integrationId ?? '');
  const [active, setActive] = useState(rule?.active ?? true);

  const integrations = useQuery({
    queryKey: ['integrations'],
    enabled: can('integrations.manage'),
    queryFn: () => api.get<{ items: Integration[] }>('/integrations'),
  });
  const kind = channel === 'in_app' ? null : CHANNEL_KIND[channel];
  const options = (integrations.data?.items ?? []).filter((i) => i.kind === kind);

  const keys = roles ? roleKeys : roleText.split(/[,\s]+/).filter(Boolean);
  const mails = emails.split(/[,;\s]+/).filter(Boolean);
  const invalid =
    (channel === 'in_app' && keys.length === 0) || (channel === 'email' && mails.length === 0) || (channel !== 'in_app' && !integrationId);

  const save = useWrite<void, Rule>({
    inlineError: true,
    invalidate: [['notification-rules']],
    success: rule ? 'Regra salva.' : 'Regra criada.',
    onSuccess: onClose,
    mutationFn: () => {
      const body = {
        event,
        channel,
        target: channel === 'in_app' ? { roleKeys: keys } : channel === 'email' ? { emails: mails } : {},
        integrationId: channel === 'in_app' ? null : integrationId,
        active,
      };
      return rule ? api.patch(`/notification-rules/${rule.id}`, body) : api.post('/notification-rules', body);
    },
  });

  return (
    <FormModal
      open
      title={rule ? 'Editar regra' : 'Nova regra de notificação'}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      busy={save.isPending}
      submitDisabled={invalid}
      error={save.errorText ? detailedError(save.error) : null}
    >
      <Select label="Evento" value={event} onChange={(e) => setEvent(e.target.value)} options={NOTIFICATION_EVENTS.map((e) => ({ value: e, label: eventLabel(e) }))} />
      <Select
        label="Canal"
        value={channel}
        onChange={(e) => {
          setChannel(e.target.value as NotificationChannel);
          setIntegrationId('');
        }}
        options={NOTIFICATION_CHANNELS.map((c) => {
          const off = c !== 'in_app' && !hasModule(CHANNEL_MODULE[c]);
          return { value: c, label: off ? `${CHANNEL_LABELS[c]} (módulo inativo)` : CHANNEL_LABELS[c], disabled: off };
        })}
      />
      {channel === 'in_app' &&
        (roles ? (
          <fieldset className="pilha" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend><strong>Papéis que recebem o aviso</strong></legend>
            {roles.map((r) => (
              <Checkbox
                key={r.key}
                label={r.name}
                checked={roleKeys.includes(r.key)}
                onChange={(e) => setRoleKeys(e.target.checked ? [...roleKeys, r.key] : roleKeys.filter((k) => k !== r.key))}
              />
            ))}
          </fieldset>
        ) : (
          <Field label="Papéis (chaves separadas por vírgula)" value={roleText} onChange={(e) => setRoleText(e.target.value)} />
        ))}
      {channel === 'email' && (
        <Field label="E-mails de destino" multiline required value={emails} onChange={(e) => setEmails(e.target.value)} hint="Um por linha ou separados por vírgula (até 20)." />
      )}
      {channel !== 'in_app' && (
        <Select
          label={channel === 'email' ? 'Integração SMTP' : 'Integração de webhook'}
          required
          placeholder="Selecione"
          value={integrationId}
          onChange={(e) => setIntegrationId(e.target.value)}
          options={options.map((i) => ({ value: i.id, label: i.name }))}
          hint={options.length === 0 ? 'Cadastre a integração em Configurações, Integrações.' : undefined}
        />
      )}
      <Checkbox label="Regra ativa" checked={active} onChange={(e) => setActive(e.target.checked)} />
    </FormModal>
  );
}

function RulesTab({ writable }: { writable: boolean }) {
  const { can, hasModule } = useAuth();
  const rules = useQuery({ queryKey: ['notification-rules'], queryFn: () => api.get<{ items: Rule[] }>('/notification-rules') });
  const roles = useQuery({ queryKey: ['roles'], enabled: can('users.manage'), queryFn: () => api.get<{ items: { key: string; name: string }[] }>('/roles') });
  const integrations = useQuery({ queryKey: ['integrations'], enabled: can('integrations.manage'), queryFn: () => api.get<{ items: Integration[] }>('/integrations') });
  const [form, setForm] = useState<{ rule: Rule | null } | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const del = useWrite({
    invalidate: [['notification-rules']],
    mutationFn: (r: Rule) => api.delete(`/notification-rules/${r.id}`),
    success: 'Regra excluída.',
    onSuccess: () => setDeleting(null),
  });
  const roleNames = new Map((roles.data?.items ?? []).map((r) => [r.key, r.name]));
  const integrationNames = new Map((integrations.data?.items ?? []).map((i) => [i.id, i.name]));

  const columns: Column<Rule>[] = [
    { key: 'event', header: 'Evento', render: (r) => <strong>{eventLabel(r.event)}</strong> },
    {
      key: 'channel',
      header: 'Canal',
      render: (r) => (
        <>
          {CHANNEL_LABELS[r.channel]}
          {r.channel !== 'in_app' && !hasModule(CHANNEL_MODULE[r.channel]) && <Badge tone="warning">Módulo inativo</Badge>}
        </>
      ),
    },
    { key: 'target', header: 'Destino', render: (r) => targetText(r, roleNames) },
    { key: 'integration', header: 'Integração', hideOnMobile: true, render: (r) => (r.integrationId ? integrationNames.get(r.integrationId) ?? '—' : '—') },
    { key: 'active', header: 'Situação', render: (r) => <Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Ativa' : 'Inativa'}</Badge> },
    {
      key: 'acoes',
      header: 'Ações',
      render: (r) =>
        writable ? (
          <span className="linha">
            <Button size="sm" onClick={() => setForm({ rule: r })}>Editar<span className="sr-only"> regra de {eventLabel(r.event)}</span></Button>
            <Button size="sm" variant="danger" onClick={() => setDeleting(r)}>Excluir<span className="sr-only"> regra de {eventLabel(r.event)}</span></Button>
          </span>
        ) : null,
    },
  ];

  return (
    <div className="pilha">
      <p className="texto-suave">
        Sem regras, as aprovações pendentes e outros eventos já geram avisos internos para quem pode agir. Use regras para avisar outros papéis ou enviar por e-mail e webhook.
      </p>
      {writable && (
        <div><Button variant="primary" onClick={() => setForm({ rule: null })}>Nova regra</Button></div>
      )}
      <DataTable<Rule>
        caption="Regras de notificação"
        columns={columns}
        rows={rules.data?.items}
        rowKey={(r) => r.id}
        loading={rules.isLoading}
        error={rules.isError ? errorMessage(rules.error) : null}
        onRetry={() => void rules.refetch()}
        emptyTitle="Nenhuma regra cadastrada"
      />
      {form && <RuleForm key={form.rule?.id ?? 'nova'} rule={form.rule} roles={roles.data?.items ?? null} onClose={() => setForm(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title="Excluir regra"
        message="Excluir esta regra de notificação?"
        confirmLabel="Excluir"
        destructive
        onConfirm={() => deleting && del.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function DeliveriesTab() {
  const [status, setStatus] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const q = useQuery({
    queryKey: ['notification-deliveries', status, cursor],
    placeholderData: (prev) => prev,
    queryFn: () => api.get<Page<Delivery>>('/notification-deliveries', { status, limit: 25, cursor }),
  });
  const next = q.data?.nextCursor ?? undefined;
  const columns: Column<Delivery>[] = [
    { key: 'when', header: 'Data', render: (d) => <DateText value={d.createdAt} withTime /> },
    { key: 'event', header: 'Evento', render: (d) => eventLabel(d.event) },
    { key: 'channel', header: 'Canal', render: (d) => CHANNEL_LABELS[d.channel as NotificationChannel] ?? d.channel },
    { key: 'status', header: 'Situação', render: (d) => { const s = DELIVERY_STATUS[d.status] ?? { label: d.status, tone: 'neutral' as BadgeTone }; return <Badge tone={s.tone}>{s.label}</Badge>; } },
    { key: 'attempts', header: 'Tentativas', align: 'right', hideOnMobile: true, render: (d) => d.attempts },
    { key: 'error', header: 'Erro', render: (d) => d.error ?? (d.responseStatus ? `Resposta ${d.responseStatus}` : '—') },
  ];
  return (
    <div className="pilha">
      <Select
        label="Situação"
        placeholder="Todas"
        value={status}
        onChange={(e) => { setStatus(e.target.value); setCursors([undefined]); }}
        options={Object.entries(DELIVERY_STATUS).map(([value, v]) => ({ value, label: v.label }))}
      />
      <DataTable<Delivery>
        caption="Histórico de entregas"
        columns={columns}
        rows={q.data?.items}
        rowKey={(d) => d.id}
        loading={q.isLoading}
        error={q.isError ? errorMessage(q.error) : null}
        onRetry={() => void q.refetch()}
        emptyTitle="Nenhuma entrega registrada"
        emptyDescription="Entregas por e-mail e webhook aparecem aqui."
        footer={
          <Pagination
            hasPrev={cursors.length > 1}
            hasNext={Boolean(next)}
            loading={q.isFetching}
            onPrev={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => next && setCursors((c) => [...c, next])}
            summary={`Página ${cursors.length}`}
          />
        }
      />
    </div>
  );
}

export function NotificacoesPage() {
  const { can, readOnly } = useAuth();
  const [tab, setTab] = useState('regras');
  return (
    <>
      <PageHeader title="Notificações" subtitle="Quem é avisado de cada evento, e o histórico das entregas externas." />
      <Tabs label="Notificações" value={tab} onChange={setTab} tabs={[{ key: 'regras', label: 'Regras' }, { key: 'entregas', label: 'Entregas' }]} />
      <div role="tabpanel" style={{ marginTop: 'var(--e4)' }}>
        {tab === 'regras' ? <RulesTab writable={can('settings.manage') && !readOnly} /> : <DeliveriesTab />}
      </div>
      <p className="texto-suave">
        Canais de e-mail e webhook dependem de integrações verificadas. <Link to="/configuracoes/integracoes">Ver Integrações</Link>
      </p>
    </>
  );
}
