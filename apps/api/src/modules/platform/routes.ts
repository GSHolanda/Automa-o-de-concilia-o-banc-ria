import { z } from 'zod';
import type { AuditActor } from '../../audit/audit';
import type { Db } from '../../db/context';
import type { AuthContext } from '../../http/auth';
import { badRequest, conflict, notFound } from '../../http/errors';
import { created, route, type RouteDefinition } from '../../http/route';
import { auditQuery, listAudit } from '../audit/routes';
import { provisionTenant } from '../tenancy/provisioning';

// ---------------------------------------------------------------------------
// Consultas auxiliares
// ---------------------------------------------------------------------------

interface TenantRow {
  id: string;
  slug: string;
  legal_name: string;
  trade_name: string;
  tax_id: string | null;
  status: string;
  onboarding: unknown;
  created_at: Date;
  updated_at: Date;
  plan_code: string | null;
  plan_name: string | null;
  license_status: string | null;
  valid_from: string | null;
  valid_until: string | null;
  limits_override: Record<string, unknown> | null;
  external_ref: string | null;
  notes: string | null;
  user_count: number;
}

const TENANT_SELECT = `
  SELECT t.id, t.slug, t.legal_name, t.trade_name, t.tax_id, t.status, t.onboarding, t.created_at, t.updated_at,
         l.plan_code, p.name AS plan_name, l.status AS license_status,
         to_char(l.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(l.valid_until, 'YYYY-MM-DD') AS valid_until,
         l.limits_override, l.external_ref, l.notes,
         (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.status = 'active') AS user_count
    FROM tenants t
    LEFT JOIN tenant_licenses l ON l.tenant_id = t.id
    LEFT JOIN plans p ON p.code = l.plan_code`;

function tenantSummary(row: TenantRow) {
  return {
    id: row.id,
    slug: row.slug,
    legalName: row.legal_name,
    tradeName: row.trade_name,
    taxId: row.tax_id,
    status: row.status,
    planCode: row.plan_code,
    planName: row.plan_name,
    licenseStatus: row.license_status,
    validUntil: row.valid_until,
    userCount: row.user_count,
    createdAt: row.created_at.toISOString(),
  };
}

function licenseView(row: TenantRow) {
  if (row.plan_code === null) return null;
  return {
    planCode: row.plan_code,
    planName: row.plan_name,
    status: row.license_status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    limitsOverride: row.limits_override ?? {},
    externalRef: row.external_ref,
    notes: row.notes,
  };
}

async function findTenant(db: Db, id: string): Promise<TenantRow> {
  const result = await db.query<TenantRow>(`${TENANT_SELECT} WHERE t.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw notFound('Empresa não encontrada.');
  return row;
}

function platformActor(auth: AuthContext): AuditActor {
  return { type: 'platform', id: auth.userId, label: auth.name };
}

function uniqueConstraint(error: unknown): string | null {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === '23505' ? (pgError.constraint ?? null) : null;
}

// ---------------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------------

const idParams = z.object({ id: z.uuid() });

const slug = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/, 'Use letras minúsculas, números e "-" (até 50 caracteres).');
const companyName = z.string().trim().min(1).max(200);
/** CNPJ ou CPF: apenas dígitos são gravados. */
const taxId = z
  .string()
  .transform((value) => value.replace(/\D/g, ''))
  .pipe(z.string().regex(/^[0-9]{11,14}$/, 'Informe de 11 a 14 dígitos.'));

const tenantStatus = z.enum(['onboarding', 'active', 'suspended', 'archived']);

const createTenantBody = z.object({
  slug,
  legalName: companyName,
  tradeName: companyName,
  taxId: taxId.nullable().optional(),
  planCode: z.string().min(1).max(40),
  admin: z.object({ name: z.string().trim().min(1).max(120), email: z.email().max(254) }),
});

const updateTenantBody = z.object({
  legalName: companyName.optional(),
  tradeName: companyName.optional(),
  taxId: taxId.nullable().optional(),
  status: tenantStatus.optional(),
});

const limitValue = z.number().int().min(0).nullable().optional();

const licenseBody = z.object({
  planCode: z.string().min(1).max(40),
  status: z.enum(['trial', 'active', 'past_due', 'suspended', 'canceled']),
  validUntil: z.iso.date().nullable().optional(),
  limitsOverride: z
    .strictObject({ maxUsers: limitValue, maxBankAccounts: limitValue, maxMonthlyTransactions: limitValue })
    .optional(),
  externalRef: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const tenantListQuery = z.object({
  status: tenantStatus.optional(),
  q: z.string().max(100).optional(),
});

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------


export const routes: RouteDefinition[] = [
  route({
    tags: ['plataforma'],
    auth: 'platform',
    permission: null,
    method: 'GET',
    url: '/platform/tenants',
    summary: 'Listar empresas com plano, licença e número de usuários',
    query: tenantListQuery,
    handler: async ({ db, query }) => {
      const where: string[] = [];
      const values: unknown[] = [];
      if (query.status) {
        values.push(query.status);
        where.push(`t.status = $${values.length}`);
      }
      if (query.q) {
        values.push(`%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
        where.push(`(t.slug ILIKE $${values.length} OR t.trade_name ILIKE $${values.length} OR t.legal_name ILIKE $${values.length})`);
      }
      const result = await db.query<TenantRow>(
        `${TENANT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lower(t.trade_name), t.id`,
        values,
      );
      return { items: result.rows.map(tenantSummary) };
    },
  }),

  route({
    tags: ['plataforma'],
    auth: 'platform',
    permission: null,
    method: 'POST',
    url: '/platform/tenants',
    summary: 'Criar empresa com o primeiro administrador',
    body: createTenantBody,
    handler: async ({ db, auth, body, deps, req }) => {
      try {
        const provisioned = await provisionTenant(db, deps.config, {
          slug: body.slug,
          legalName: body.legalName,
          tradeName: body.tradeName,
          taxId: body.taxId ?? null,
          planCode: body.planCode,
          admin: { name: body.admin.name, email: body.admin.email },
          actor: platformActor(auth),
          requestId: req.id,
          ip: req.ip,
        });
        return created({
          tenantId: provisioned.tenantId,
          slug: provisioned.slug,
          temporaryPassword: provisioned.temporaryPassword,
        });
      } catch (error) {
        const constraint = uniqueConstraint(error);
        if (constraint === 'tenants_slug_key') throw conflict('Já existe uma empresa com este identificador.', 'slug_taken');
        if (constraint === 'users_email_unique') throw conflict('Já existe um usuário com este e-mail.', 'email_taken');
        throw error;
      }
    },
  }),

  route({
    tags: ['plataforma'],
    auth: 'platform',
    permission: null,
    method: 'GET',
    url: '/platform/tenants/:id',
    summary: 'Detalhes de uma empresa',
    params: idParams,
    handler: async ({ db, params }) => {
      const row = await findTenant(db, params.id);
      const modules = await db.query<{ module_key: string; enabled: boolean }>(
        'SELECT module_key, enabled FROM tenant_modules WHERE tenant_id = $1 ORDER BY module_key',
        [params.id],
      );
      return {
        ...tenantSummary(row),
        onboarding: row.onboarding,
        updatedAt: row.updated_at.toISOString(),
        license: licenseView(row),
        modules: modules.rows.map((entry) => ({ key: entry.module_key, enabled: entry.enabled })),
      };
    },
  }),

  route({
    tags: ['plataforma'],
    auth: 'platform',
    permission: null,
    method: 'PATCH',
    url: '/platform/tenants/:id',
    summary: 'Alterar dados ou situação de uma empresa',
    params: idParams,
    body: updateTenantBody,
    handler: async ({ db, params, body, audit }) => {
      const before = await findTenant(db, params.id);
      await db.query(
        `UPDATE tenants SET legal_name = $2, trade_name = $3, tax_id = $4, status = $5 WHERE id = $1`,
        [
          params.id,
          body.legalName ?? before.legal_name,
          body.tradeName ?? before.trade_name,
          body.taxId === undefined ? before.tax_id : body.taxId,
          body.status ?? before.status,
        ],
      );
      const after = await findTenant(db, params.id);
      const snapshot = (row: TenantRow) => ({
        legalName: row.legal_name,
        tradeName: row.trade_name,
        taxId: row.tax_id,
        status: row.status,
      });
      await audit({
        tenantId: null,
        action: 'platform.tenant_updated',
        entityType: 'tenant',
        entityId: params.id,
        summary: `Empresa "${after.trade_name}" (${after.slug}) alterada`,
        before: snapshot(before),
        after: snapshot(after),
      });
      return tenantSummary(after);
    },
  }),

  route({
    tags: ['plataforma'],
    auth: 'platform',
    permission: null,
    method: 'PUT',
    url: '/platform/tenants/:id/license',
    summary: 'Definir plano e licença de uma empresa',
    params: idParams,
    body: licenseBody,
    handler: async ({ db, params, body, audit }) => {
      const before = await findTenant(db, params.id);
      const plan = await db.query('SELECT 1 FROM plans WHERE code = $1 AND active', [body.planCode]);
      if (plan.rowCount === 0) throw badRequest(`Plano "${body.planCode}" não existe ou está inativo.`, 'invalid_plan');

      const limitsOverride = Object.fromEntries(
        Object.entries(body.limitsOverride ?? {}).filter(([, value]) => value !== undefined),
      );
      await db.query(
        `INSERT INTO tenant_licenses (tenant_id, plan_code, status, valid_until, limits_override, external_ref, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id) DO UPDATE
           SET plan_code = EXCLUDED.plan_code, status = EXCLUDED.status, valid_until = EXCLUDED.valid_until,
               limits_override = EXCLUDED.limits_override, external_ref = EXCLUDED.external_ref,
               notes = EXCLUDED.notes`,
        [
          params.id,
          body.planCode,
          body.status,
          body.validUntil ?? null,
          JSON.stringify(limitsOverride),
          body.externalRef ?? null,
          body.notes ?? null,
        ],
      );
      const after = await findTenant(db, params.id);
      await audit({
        tenantId: null,
        action: 'platform.license_updated',
        entityType: 'tenant',
        entityId: params.id,
        summary: `Licença de "${after.trade_name}" (${after.slug}): plano ${body.planCode}, situação ${body.status}`,
        before: licenseView(before),
        after: licenseView(after),
      });
      return licenseView(after);
    },
  }),

  route({
    tags: ['plataforma'],
    auth: 'platform',
    permission: null,
    method: 'GET',
    url: '/platform/plans',
    summary: 'Listar planos',
    handler: async ({ db }) => {
      const result = await db.query<{
        code: string;
        name: string;
        description: string;
        limits: Record<string, unknown>;
        modules: string[];
        active: boolean;
      }>('SELECT code, name, description, limits, modules, active FROM plans ORDER BY code');
      return { items: result.rows };
    },
  }),

  route({
    tags: ['plataforma'],
    auth: 'platform',
    permission: null,
    method: 'GET',
    url: '/platform/audit',
    summary: 'Trilha de auditoria da plataforma',
    query: auditQuery,
    handler: async ({ db, query }) => listAudit(db, null, query),
  }),
];
