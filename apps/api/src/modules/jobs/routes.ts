import { hasPermission, type PermissionKey } from '@concilia/core';
import { z } from 'zod';
import type { AuthContext } from '../../http/auth';
import { decodeTimeCursor, encodeTimeCursor } from '../../http/cursor';
import { conflict, forbidden, notFound } from '../../http/errors';
import { route, type RouteDefinition } from '../../http/route';
import { jobView, requeueJob } from '../../jobs/queue';
import { getJobHandler } from '../../jobs/registry';
import type { JobRecord } from '../../jobs/types';

const listQuery = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'dead', 'canceled']).optional(),
  type: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

const idParams = z.object({ id: z.uuid() });

/**
 * Permissão para ver e para repetir cada tipo de trabalho: repetir exige a mesma permissão da operação
 * que criou o trabalho. Tipos fora da lista (manutenção, testes) exigem `settings.manage`.
 */
const JOB_PERMISSIONS: Readonly<Record<string, { view: PermissionKey; retry: PermissionKey }>> = {
  'import.process': { view: 'imports.view', retry: 'imports.create' },
  'connector.pull': { view: 'imports.view', retry: 'imports.create' },
  'reconciliation.run': { view: 'reconciliation.view', retry: 'reconciliation.run' },
  'notification.deliver': { view: 'settings.manage', retry: 'settings.manage' },
};
const OTHER_JOBS = { view: 'settings.manage', retry: 'settings.manage' } as const;
const MAPPED_TYPES = Object.keys(JOB_PERMISSIONS);

function jobPermissions(type: string): { view: PermissionKey; retry: PermissionKey } {
  return JOB_PERMISSIONS[type] ?? OTHER_JOBS;
}

/** Tipos que o usuário pode ver e se pode ver os tipos fora da lista. */
function visibleTypes(auth: AuthContext): { types: string[]; others: boolean } {
  return {
    types: MAPPED_TYPES.filter((type) => hasPermission(auth.permissions, JOB_PERMISSIONS[type]!.view)),
    others: hasPermission(auth.permissions, OTHER_JOBS.view),
  };
}

type JobListRow = JobRecord & { cursor_at: string };

export const routes: RouteDefinition[] = [
  route({
    tags: ['fila'],
    auth: 'session',
    permission: 'imports.view',
    method: 'GET',
    url: '/jobs',
    summary: 'Listar trabalhos da fila',
    query: listQuery,
    handler: async ({ db, tenantId, auth, query }) => {
      const values: unknown[] = [tenantId];
      const where = ['tenant_id = $1'];
      const add = (clause: string, value: unknown) => {
        values.push(value);
        where.push(clause.replaceAll('?', `$${values.length}`));
      };
      // Só os tipos que o usuário pode ver (payload, resultado e erro revelam a operação).
      const visible = visibleTypes(auth);
      values.push(visible.types, visible.others, MAPPED_TYPES);
      where.push(`(type = ANY ($${values.length - 2}::text[]) OR ($${values.length - 1} AND NOT type = ANY ($${values.length}::text[])))`);
      if (query.status) add('status = ?', query.status);
      if (query.type) add('type = ?', query.type);
      if (query.cursor) {
        const cursor = decodeTimeCursor(query.cursor);
        values.push(cursor.at, cursor.id);
        where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(query.limit + 1);
      const result = await db.query<JobListRow>(
        `SELECT *, created_at::text AS cursor_at FROM jobs
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC, id DESC
          LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, query.limit);
      const last = rows.at(-1);
      const items = rows.map(jobView);
      return result.rows.length > query.limit && last
        ? { items, nextCursor: encodeTimeCursor({ at: last.cursor_at, id: last.id }) }
        : { items };
    },
  }),

  route({
    tags: ['fila'],
    auth: 'session',
    permission: 'imports.view',
    method: 'GET',
    url: '/jobs/:id',
    summary: 'Consultar um trabalho da fila',
    params: idParams,
    handler: async ({ db, tenantId, auth, params }) => {
      const result = await db.query<JobRecord>('SELECT * FROM jobs WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        params.id,
      ]);
      const row = result.rows[0];
      if (!row || !hasPermission(auth.permissions, jobPermissions(row.type).view)) throw notFound('Trabalho não encontrado.');
      return jobView(row);
    },
  }),

  route({
    tags: ['fila'],
    auth: 'session',
    // A permissão depende do tipo do trabalho (a mesma da operação que o criou): conferida no manipulador.
    permission: null,
    method: 'POST',
    url: '/jobs/:id/retry',
    summary: 'Repetir um trabalho em falha definitiva (exige a permissão da operação original)',
    params: idParams,
    handler: async ({ db, tenantId, auth, params, audit }) => {
      const current = await db.query<JobRecord>('SELECT * FROM jobs WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
        tenantId,
        params.id,
      ]);
      const job = current.rows[0];
      const permissions = job ? jobPermissions(job.type) : null;
      if (!job || !permissions || !hasPermission(auth.permissions, permissions.view)) throw notFound('Trabalho não encontrado.');
      if (!hasPermission(auth.permissions, permissions.retry)) throw forbidden();
      if (job.status !== 'dead') {
        throw conflict('Só é possível repetir trabalhos em falha definitiva.', 'invalid_status', { status: job.status });
      }
      const requeued = await requeueJob(db, tenantId, job.id);
      if (!requeued) throw conflict('O trabalho mudou de situação. Recarregue e tente de novo.', 'invalid_status');
      await getJobHandler(job.type)?.onRetry?.(db, requeued);
      await audit({
        action: 'job.retried',
        entityType: 'job',
        entityId: job.id,
        summary: `Trabalho ${job.type} devolvido à fila`,
        before: { status: job.status, attempts: job.attempts, lastError: job.last_error },
        after: { status: requeued.status, attempts: requeued.attempts },
      });
      return jobView(requeued);
    },
  }),
];
