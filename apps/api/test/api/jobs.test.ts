import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueue, retryDelayMs } from '../../src/jobs/queue';
import { registerJobHandler } from '../../src/jobs/registry';
import { buildTestApp, createTenant, loggedIn, userWithRole, type ApiClient, type TestTenant } from '../helpers/app';
import { asTenant, closePools, ownerPool } from '../helpers/db';
import { drainJobs, makeJobsDue } from '../helpers/imports';

let app: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;
let admin: ApiClient;
let otherAdmin: ApiClient;
const restore: Array<() => void> = [];

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'fila' });
  other = await createTenant({ label: 'fila-outra' });
  admin = await loggedIn(app, tenant.adminEmail);
  otherAdmin = await loggedIn(app, other.adminEmail);

  restore.push(
    registerJobHandler('test.echo', {
      run: async ({ job, audit }) => {
        await audit({ action: 'test.echo', entityType: 'job', entityId: job.id, summary: 'eco' });
        return { echoed: job.payload };
      },
    }),
    registerJobHandler('test.fail', {
      run: async () => {
        throw new Error('Falha simulada do serviço');
      },
    }),
  );
});

afterAll(async () => {
  for (const undo of restore) undo();
  await app.close();
  await closePools();
});

describe('enqueue', () => {
  it('é idempotente pela chave: a segunda chamada devolve o trabalho existente', async () => {
    const first = await asTenant(tenant.tenantId, (db) =>
      enqueue(db, { tenantId: tenant.tenantId, type: 'test.echo', payload: { n: 1 }, idempotencyKey: 'chave-1' }),
    );
    const second = await asTenant(tenant.tenantId, (db) =>
      enqueue(db, { tenantId: tenant.tenantId, type: 'test.echo', payload: { n: 2 }, idempotencyKey: 'chave-1' }),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.payload).toEqual({ n: 1 });

    // A mesma chave em outra empresa é outro trabalho.
    const elsewhere = await asTenant(other.tenantId, (db) =>
      enqueue(db, { tenantId: other.tenantId, type: 'test.echo', payload: {}, idempotencyKey: 'chave-1' }),
    );
    expect(elsewhere.created).toBe(true);

    const summary = await drainJobs(app);
    expect(summary.succeeded).toBeGreaterThanOrEqual(2);
    const row = await ownerPool().query('SELECT status, result, attempts FROM jobs WHERE id = $1', [first.job.id]);
    expect(row.rows[0]).toMatchObject({ status: 'succeeded', result: { echoed: { n: 1 } }, attempts: 1 });
  });

  it('espera progressiva: 2^tentativas × 5 s, no máximo 10 minutos', () => {
    expect(retryDelayMs(1)).toBe(10_000);
    expect(retryDelayMs(2)).toBe(20_000);
    expect(retryDelayMs(3)).toBe(40_000);
    expect(retryDelayMs(10)).toBe(600_000);
  });
});

describe('trabalho que falha (CA-22)', () => {
  it('é repetido com espera até o limite e termina morto, com erro, auditoria e aviso', async () => {
    const { job } = await asTenant(tenant.tenantId, (db) =>
      enqueue(db, { tenantId: tenant.tenantId, type: 'test.fail', payload: {}, idempotencyKey: 'falha-1', maxAttempts: 3 }),
    );

    expect((await drainJobs(app)).retried).toBe(1);
    let row = (await ownerPool().query('SELECT * FROM jobs WHERE id = $1', [job.id])).rows[0];
    expect(row).toMatchObject({ status: 'queued', attempts: 1, last_error: 'Falha simulada do serviço' });
    // Primeira espera de 10 s: não é capturado de novo na mesma drenagem.
    expect(new Date(row.run_at).getTime() - Date.now()).toBeGreaterThan(8_000);
    expect((await drainJobs(app)).processed).toBe(0);

    await makeJobsDue([job.id]);
    expect((await drainJobs(app)).retried).toBe(1);
    await makeJobsDue([job.id]);
    expect((await drainJobs(app)).dead).toBe(1);

    row = (await ownerPool().query('SELECT * FROM jobs WHERE id = $1', [job.id])).rows[0];
    expect(row).toMatchObject({ status: 'dead', attempts: 3, last_error: 'Falha simulada do serviço' });
    expect(row.finished_at).not.toBeNull();

    const audit = await admin.get(`/audit?action=job.dead&entityId=${job.id}`);
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0].actorType).toBe('system');

    const notices = await ownerPool().query(
      `SELECT n.user_id FROM notifications n WHERE n.tenant_id = $1 AND n.event = 'job.dead'`,
      [tenant.tenantId],
    );
    expect(notices.rows.map((entry) => entry.user_id)).toContain(tenant.adminUserId);

    const listed = await admin.get('/jobs?status=dead');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toContain(job.id);
    expect(listed.body.items[0]).toMatchObject({ status: 'dead', lastError: 'Falha simulada do serviço', maxAttempts: 3 });

    // Repetição manual: volta à fila com as tentativas zeradas.
    const retried = await admin.post(`/jobs/${job.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: 'queued', attempts: 0 });
    expect((await admin.post(`/jobs/${job.id}/retry`)).status).toBe(409);
  });
});

describe('rotas /jobs', () => {
  it('filtram por tipo e situação, paginam e exigem permissão', async () => {
    for (let index = 0; index < 3; index += 1) {
      await asTenant(tenant.tenantId, (db) =>
        enqueue(db, { tenantId: tenant.tenantId, type: 'test.page', payload: { index }, idempotencyKey: `p-${index}` }),
      );
    }
    const first = await admin.get('/jobs?type=test.page&limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await admin.get(`/jobs?type=test.page&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeUndefined();
    const ids = [...first.body.items, ...second.body.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(3);

    expect((await admin.get('/jobs?cursor=invalido')).status).toBe(400);

    const auditor = await userWithRole(app, admin, 'auditor');
    expect((await auditor.get('/jobs')).status).toBe(200);
    const anyJob = first.body.items[0].id;
    // Tipo fora do mapa de permissões só é visível para quem tem settings.manage (achado 9).
    expect((await auditor.post(`/jobs/${anyJob}/retry`)).status).toBe(404);
    // Trabalho na fila não pode ser "repetido".
    expect((await admin.post(`/jobs/${anyJob}/retry`)).body.error.code).toBe('invalid_status');
  });

  it('isolam empresas: outra empresa não vê nem repete os trabalhos', async () => {
    const mine = await admin.get('/jobs?limit=200');
    const theirs = await otherAdmin.get('/jobs?limit=200');
    const mineIds = new Set(mine.body.items.map((item: { id: string }) => item.id));
    expect(theirs.body.items.some((item: { id: string }) => mineIds.has(item.id))).toBe(false);
    const dead = mine.body.items.find((item: { type: string }) => item.type === 'test.fail');
    expect((await otherAdmin.get(`/jobs/${dead.id}`)).status).toBe(404);
    expect((await otherAdmin.post(`/jobs/${dead.id}/retry`)).status).toBe(404);
  });
});

describe('achado 9: permissão por tipo de trabalho', () => {
  async function deadJob(type: string, payload: Record<string, unknown>): Promise<string> {
    const { job } = await asTenant(tenant.tenantId, (db) =>
      enqueue(db, { tenantId: tenant.tenantId, type, payload, idempotencyKey: `morto-${type}-${Date.now()}` }),
    );
    await ownerPool().query(`UPDATE jobs SET status = 'dead', attempts = max_attempts, finished_at = now() WHERE id = $1`, [job.id]);
    return job.id;
  }

  it('quem só importa não repete nem vê conciliação; repete e vê o que é de importação', async () => {
    const created = await admin.post('/roles', { key: 'so-importa', name: 'Só importa', permissions: ['imports.view', 'imports.create'] });
    expect(created.status).toBe(201);
    const importer = await userWithRole(app, admin, 'so-importa');
    const reconciliation = await deadJob('reconciliation.run', { runId: '00000000-0000-4000-8000-000000000001' });
    const pull = await deadJob('connector.pull', { integrationId: '00000000-0000-4000-8000-000000000002', dateFrom: '2024-01-01', dateTo: '2024-01-02' });

    const refused = await importer.post(`/jobs/${reconciliation}/retry`);
    expect(refused.status).toBe(404);
    expect((await importer.get(`/jobs/${reconciliation}`)).status).toBe(404);
    const listed = await importer.get('/jobs?limit=200');
    const types = new Set(listed.body.items.map((item: { type: string }) => item.type));
    expect(types.has('reconciliation.run')).toBe(false);
    expect(types.has('test.fail')).toBe(false);
    expect(listed.body.items.some((item: { id: string }) => item.id === pull)).toBe(true);

    const retried = await importer.post(`/jobs/${pull}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('queued');
    await ownerPool().query(`UPDATE jobs SET status = 'canceled' WHERE id = $1`, [pull]);

    // Quem vê conciliação mas não a executa enxerga o trabalho e não o repete.
    const viewer = await userWithRole(app, admin, 'auditor');
    expect((await viewer.get(`/jobs/${reconciliation}`)).status).toBe(200);
    expect((await viewer.post(`/jobs/${reconciliation}/retry`)).status).toBe(403);
    // O administrador repete.
    expect((await admin.post(`/jobs/${reconciliation}/retry`)).status).toBe(200);
    await ownerPool().query(`UPDATE jobs SET status = 'canceled' WHERE id = $1`, [reconciliation]);
  });
});

describe('trabalhador contínuo', () => {
  it('inicia com a API quando habilitado e para no encerramento', async () => {
    await ownerPool().query(`UPDATE jobs SET status = 'canceled' WHERE status = 'queued'`);
    const { job } = await asTenant(tenant.tenantId, (db) =>
      enqueue(db, { tenantId: tenant.tenantId, type: 'test.echo', payload: { auto: true }, idempotencyKey: 'auto-1' }),
    );
    const live = await buildTestApp({ WORKER_ENABLED: 'true', WORKER_POLL_MS: '100' });
    try {
      let status = 'queued';
      for (let attempt = 0; attempt < 50 && status !== 'succeeded'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = (await ownerPool().query('SELECT status FROM jobs WHERE id = $1', [job.id])).rows[0].status;
      }
      expect(status).toBe('succeeded');
    } finally {
      await live.close();
    }
  });
});
