import {
  emailTargetSchema,
  inAppTargetSchema,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  type NotificationChannel,
} from '@concilia/core';
import { z } from 'zod';
import type { Db } from '../../db/context';
import { decodeTimeCursor, encodeTimeCursor } from '../../http/cursor';
import { AppError, badRequest, notFound } from '../../http/errors';
import { created, noContent, route, type RouteDefinition } from '../../http/route';
import type { Entitlements } from '../tenancy/entitlements';

interface RuleRow {
  id: string;
  event: string;
  channel: NotificationChannel;
  target: Record<string, unknown>;
  integration_id: string | null;
  template: Record<string, unknown>;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function ruleView(row: RuleRow) {
  return {
    id: row.id,
    event: row.event,
    channel: row.channel,
    target: row.target,
    integrationId: row.integration_id,
    template: row.template,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const idParams = z.object({ id: z.uuid() });
const jsonObject = z.record(z.string(), z.unknown());

const ruleBody = z.object({
  event: z.enum(NOTIFICATION_EVENTS),
  channel: z.enum(NOTIFICATION_CHANNELS),
  target: jsonObject.default({}),
  integrationId: z.uuid().nullish(),
  template: jsonObject.default({}),
  active: z.boolean().default(true),
});

const ruleUpdate = z.object({
  event: z.enum(NOTIFICATION_EVENTS).optional(),
  channel: z.enum(NOTIFICATION_CHANNELS).optional(),
  target: jsonObject.optional(),
  integrationId: z.uuid().nullable().optional(),
  template: jsonObject.optional(),
  active: z.boolean().optional(),
});

type RuleInput = z.output<typeof ruleBody>;

const CHANNEL_RULES = {
  webhook: { module: 'notifications.webhook', kind: 'webhook' },
  email: { module: 'notifications.email', kind: 'smtp' },
} as const;

/** Confere destino, integração e módulo conforme o canal. Devolve o destino normalizado. */
async function validateRule(db: Db, tenantId: string, rule: RuleInput, entitlements: Entitlements) {
  const invalidTarget = (issues: z.core.$ZodIssue[]) =>
    badRequest(
      'Destino da regra inválido.',
      'validation_error',
      issues.map((issue) => ({ path: ['target', ...issue.path].join('.'), message: issue.message })),
    );
  if (rule.channel === 'in_app') {
    const target = inAppTargetSchema.safeParse(rule.target);
    if (!target.success) throw invalidTarget(target.error.issues);
    if (rule.integrationId) throw badRequest('Aviso interno não usa integração.', 'invalid_integration');
    const roles = await db.query<{ key: string }>('SELECT key FROM roles WHERE tenant_id = $1 AND key = ANY ($2::text[])', [
      tenantId,
      target.data.roleKeys,
    ]);
    const known = new Set(roles.rows.map((row) => row.key));
    const missing = target.data.roleKeys.filter((key) => !known.has(key));
    if (missing.length > 0) throw badRequest(`Papel inexistente: ${missing.join(', ')}.`, 'invalid_role');
    return { target: { roleKeys: [...new Set(target.data.roleKeys)] }, integrationId: null };
  }

  const requirement = CHANNEL_RULES[rule.channel];
  if (!entitlements.modules.includes(requirement.module)) {
    throw new AppError(403, 'module_disabled', 'Este módulo não está habilitado para a empresa.', { module: requirement.module });
  }
  if (!rule.integrationId) throw badRequest('Informe a integração da regra.', 'invalid_integration');
  const integration = await db.query<{ kind: string }>('SELECT kind FROM integrations WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    rule.integrationId,
  ]);
  if (integration.rows[0]?.kind !== requirement.kind) {
    throw badRequest(`Integração inexistente ou de outro tipo (esperado: ${requirement.kind}).`, 'invalid_integration');
  }
  if (rule.channel === 'email') {
    const target = emailTargetSchema.safeParse(rule.target);
    if (!target.success) throw invalidTarget(target.error.issues);
    return { target: { emails: [...new Set(target.data.emails)] }, integrationId: rule.integrationId };
  }
  return { target: {}, integrationId: rule.integrationId };
}

async function findRule(db: Db, tenantId: string, id: string): Promise<RuleRow> {
  const result = await db.query<RuleRow>('SELECT * FROM notification_rules WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
    tenantId,
    id,
  ]);
  const row = result.rows[0];
  if (!row) throw notFound('Regra de notificação não encontrada.');
  return row;
}

const pageQuery = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
};

export const routes: RouteDefinition[] = [
  route({
    tags: ['notificações'],
    auth: 'session',
    permission: 'settings.manage',
    method: 'GET',
    url: '/notification-rules',
    summary: 'Listar regras de notificação',
    handler: async ({ db, tenantId }) => {
      const result = await db.query<RuleRow>(
        'SELECT * FROM notification_rules WHERE tenant_id = $1 ORDER BY event, channel, created_at, id',
        [tenantId],
      );
      return { items: result.rows.map(ruleView) };
    },
  }),

  route({
    tags: ['notificações'],
    auth: 'session',
    permission: 'settings.manage',
    method: 'POST',
    url: '/notification-rules',
    summary: 'Criar regra de notificação (in_app, email ou webhook)',
    body: ruleBody,
    handler: async ({ db, tenantId, body, audit, entitlements }) => {
      const valid = await validateRule(db, tenantId, body, await entitlements());
      const inserted = await db.query<RuleRow>(
        `INSERT INTO notification_rules (tenant_id, event, channel, target, integration_id, template, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [tenantId, body.event, body.channel, JSON.stringify(valid.target), valid.integrationId, JSON.stringify(body.template), body.active],
      );
      const view = ruleView(inserted.rows[0]!);
      await audit({
        action: 'notification_rule.created',
        entityType: 'notification_rule',
        entityId: view.id,
        summary: `Regra de notificação ${view.event} por ${view.channel} criada`,
        after: view,
      });
      return created(view);
    },
  }),

  route({
    tags: ['notificações'],
    auth: 'session',
    permission: 'settings.manage',
    method: 'PATCH',
    url: '/notification-rules/:id',
    summary: 'Alterar regra de notificação',
    params: idParams,
    body: ruleUpdate,
    handler: async ({ db, tenantId, params, body, audit, entitlements }) => {
      const row = await findRule(db, tenantId, params.id);
      const merged = ruleBody.parse({
        event: body.event ?? row.event,
        channel: body.channel ?? row.channel,
        target: body.target ?? row.target,
        integrationId: body.integrationId === undefined ? row.integration_id : body.integrationId,
        template: body.template ?? row.template,
        active: body.active ?? row.active,
      });
      const valid = await validateRule(db, tenantId, merged, await entitlements());
      const updated = await db.query<RuleRow>(
        `UPDATE notification_rules SET event = $3, channel = $4, target = $5, integration_id = $6, template = $7, active = $8
          WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [
          tenantId,
          row.id,
          merged.event,
          merged.channel,
          JSON.stringify(valid.target),
          valid.integrationId,
          JSON.stringify(merged.template),
          merged.active,
        ],
      );
      const view = ruleView(updated.rows[0]!);
      await audit({
        action: 'notification_rule.updated',
        entityType: 'notification_rule',
        entityId: row.id,
        summary: `Regra de notificação ${view.event} por ${view.channel} alterada`,
        before: ruleView(row),
        after: view,
      });
      return view;
    },
  }),

  route({
    tags: ['notificações'],
    auth: 'session',
    permission: 'settings.manage',
    method: 'DELETE',
    url: '/notification-rules/:id',
    summary: 'Excluir regra de notificação',
    params: idParams,
    handler: async ({ db, tenantId, params, audit }) => {
      const row = await findRule(db, tenantId, params.id);
      await db.query('DELETE FROM notification_rules WHERE tenant_id = $1 AND id = $2', [tenantId, row.id]);
      await audit({
        action: 'notification_rule.deleted',
        entityType: 'notification_rule',
        entityId: row.id,
        summary: `Regra de notificação ${row.event} por ${row.channel} excluída`,
        before: ruleView(row),
      });
      return noContent();
    },
  }),

  route({
    tags: ['notificações'],
    auth: 'session',
    permission: null,
    method: 'GET',
    url: '/notifications',
    summary: 'Avisos do usuário (mais recentes primeiro)',
    query: z.object({ unread: z.enum(['true', 'false']).optional(), ...pageQuery }),
    handler: async ({ db, tenantId, auth, query }) => {
      const values: unknown[] = [tenantId, auth.userId];
      const where = ['tenant_id = $1', 'user_id = $2'];
      if (query.unread === 'true') where.push('read_at IS NULL');
      if (query.cursor) {
        const cursor = decodeTimeCursor(query.cursor);
        values.push(cursor.at, cursor.id);
        where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(query.limit + 1);
      const result = await db.query<{
        id: string;
        event: string;
        title: string;
        body: string;
        link: string | null;
        read_at: Date | null;
        created_at: Date;
        cursor_at: string;
      }>(
        `SELECT id, event, title, body, link, read_at, created_at, created_at::text AS cursor_at FROM notifications
          WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      const unread = await db.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL',
        [tenantId, auth.userId],
      );
      const rows = result.rows.slice(0, query.limit);
      const items = rows.map((row) => ({
        id: row.id,
        event: row.event,
        title: row.title,
        body: row.body,
        link: row.link,
        readAt: row.read_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      }));
      const last = rows.at(-1);
      return {
        items,
        unreadCount: unread.rows[0]?.total ?? 0,
        ...(result.rows.length > query.limit && last ? { nextCursor: encodeTimeCursor({ at: last.cursor_at, id: last.id }) } : {}),
      };
    },
  }),

  route({
    tags: ['notificações'],
    auth: 'session',
    permission: null,
    method: 'POST',
    url: '/notifications/:id/read',
    summary: 'Marcar aviso como lido',
    params: idParams,
    handler: async ({ db, tenantId, auth, params, audit }) => {
      const updated = await db.query<{ id: string }>(
        `UPDATE notifications SET read_at = coalesce(read_at, now())
          WHERE tenant_id = $1 AND id = $2 AND user_id = $3 RETURNING id`,
        [tenantId, params.id, auth.userId],
      );
      if (!updated.rows[0]) throw notFound('Aviso não encontrado.');
      await audit({ action: 'notification.read', entityType: 'notification', entityId: params.id, summary: 'Aviso marcado como lido' });
      return noContent();
    },
  }),

  route({
    tags: ['notificações'],
    auth: 'session',
    permission: null,
    method: 'POST',
    url: '/notifications/read-all',
    summary: 'Marcar todos os avisos do usuário como lidos',
    handler: async ({ db, tenantId, auth, audit }) => {
      const updated = await db.query(
        'UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL',
        [tenantId, auth.userId],
      );
      await audit({
        action: 'notification.read_all',
        entityType: 'notification',
        summary: `${updated.rowCount ?? 0} aviso(s) marcado(s) como lido(s)`,
      });
      return noContent();
    },
  }),

  route({
    tags: ['notificações'],
    auth: 'session',
    permission: 'settings.manage',
    method: 'GET',
    url: '/notification-deliveries',
    summary: 'Registro de entregas externas (webhook e e-mail)',
    query: z.object({
      status: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(),
      event: z.string().max(60).optional(),
      channel: z.enum(['email', 'webhook']).optional(),
      ...pageQuery,
    }),
    handler: async ({ db, tenantId, query }) => {
      const values: unknown[] = [tenantId];
      const where = ['tenant_id = $1'];
      const add = (clause: string, value: unknown) => {
        values.push(value);
        where.push(clause.replace('?', `$${values.length}`));
      };
      if (query.status) add('status = ?', query.status);
      if (query.event) add('event = ?', query.event);
      if (query.channel) add('channel = ?', query.channel);
      if (query.cursor) {
        const cursor = decodeTimeCursor(query.cursor);
        values.push(cursor.at, cursor.id);
        where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(query.limit + 1);
      const result = await db.query<{
        id: string;
        rule_id: string | null;
        integration_id: string | null;
        channel: string;
        event: string;
        status: string;
        attempts: number;
        response_status: number | null;
        error: string | null;
        payload: unknown;
        created_at: Date;
        sent_at: Date | null;
        cursor_at: string;
      }>(
        `SELECT *, created_at::text AS cursor_at FROM notification_deliveries
          WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, query.limit);
      const items = rows.map((row) => ({
        id: row.id,
        ruleId: row.rule_id,
        integrationId: row.integration_id,
        channel: row.channel,
        event: row.event,
        status: row.status,
        attempts: row.attempts,
        responseStatus: row.response_status,
        error: row.error,
        payload: row.payload,
        createdAt: row.created_at.toISOString(),
        sentAt: row.sent_at?.toISOString() ?? null,
      }));
      const last = rows.at(-1);
      return result.rows.length > query.limit && last
        ? { items, nextCursor: encodeTimeCursor({ at: last.cursor_at, id: last.id }) }
        : { items };
    },
  }),
];
