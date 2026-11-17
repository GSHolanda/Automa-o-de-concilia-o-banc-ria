import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { withContext, type Db, type DbContext } from '../../src/db/context';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não definido: a configuração global de testes não rodou`);
  return value;
}

let owner: pg.Pool | undefined;
let app: pg.Pool | undefined;

/** Conexão como dono do esquema: ignora RLS. Usada apenas para preparar e inspecionar dados nos testes. */
export function ownerPool(): pg.Pool {
  owner ??= new pg.Pool({ connectionString: required('TEST_OWNER_DATABASE_URL'), max: 4 });
  return owner;
}

/** Conexão com o papel da aplicação: sujeita a RLS, como em produção. */
export function appPool(): pg.Pool {
  app ??= new pg.Pool({ connectionString: required('TEST_APP_DATABASE_URL'), max: 8 });
  return app;
}

export async function closePools(): Promise<void> {
  await Promise.all([owner?.end(), app?.end()]);
  owner = undefined;
  app = undefined;
}

export function asTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>, extra: Partial<DbContext> = {}): Promise<T> {
  return withContext(appPool(), { tenantId, ...extra }, fn);
}

export interface RawTenant {
  id: string;
  slug: string;
  roleId: string;
  userId: string;
  bankAccountId: string;
}

/** Cria uma empresa mínima diretamente no banco, sem passar pela aplicação. */
export async function insertRawTenant(label = 'empresa'): Promise<RawTenant> {
  const pool = ownerPool();
  const suffix = randomBytes(4).toString('hex');
  const slug = `${label}-${suffix}`;
  const tenant = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, trade_name, status) VALUES ($1, $2, $2, 'active') RETURNING id`,
    [slug, `Empresa Fictícia ${suffix}`],
  );
  const id = tenant.rows[0]!.id;
  const role = await pool.query<{ id: string }>(
    `INSERT INTO roles (tenant_id, key, name, is_system, permissions) VALUES ($1, 'admin', 'Administrador', true, '{}') RETURNING id`,
    [id],
  );
  const roleId = role.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, role_id, email, name, password_hash) VALUES ($1, $2, $3, 'Pessoa Teste', 'x') RETURNING id`,
    [id, roleId, `pessoa-${suffix}@exemplo.test`],
  );
  const account = await pool.query<{ id: string }>(
    `INSERT INTO bank_accounts (tenant_id, name) VALUES ($1, 'Conta Movimento') RETURNING id`,
    [id],
  );
  return { id, slug, roleId, userId: user.rows[0]!.id, bankAccountId: account.rows[0]!.id };
}

export async function insertRawBankTransaction(
  tenant: RawTenant,
  overrides: { amountCents?: number; date?: string; description?: string } = {},
): Promise<string> {
  const pool = ownerPool();
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO import_batches (tenant_id, source_kind, bank_account_id, file_name, file_format, file_sha256, status)
     VALUES ($1, 'bank', $2, 'teste.ofx', 'ofx', $3, 'completed') RETURNING id`,
    [tenant.id, tenant.bankAccountId, randomUUID()],
  );
  const description = overrides.description ?? 'PIX RECEBIDO CLIENTE FICTICIO';
  const row = await pool.query<{ id: string }>(
    `INSERT INTO bank_transactions
       (tenant_id, bank_account_id, batch_id, row_number, posted_date, amount_cents,
        description_raw, description_norm, dedup_key, similarity_key)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $6, $7, $7) RETURNING id`,
    [tenant.id, tenant.bankAccountId, batch.rows[0]!.id, overrides.date ?? '2024-01-05',
     overrides.amountCents ?? 10000, description, randomUUID()],
  );
  return row.rows[0]!.id;
}
