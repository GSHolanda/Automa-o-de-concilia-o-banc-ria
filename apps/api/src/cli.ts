import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config/env';
import { withContext } from './db/context';
import { migrate } from './db/migrate';
import { createPool } from './db/pool';
import { AppError } from './http/errors';
import { DemoSeedError, seedDemo } from './demo/seed';
import { verifyAuditChain } from './modules/audit/routes';
import { createPlatformAdmin, provisionTenant } from './modules/tenancy/provisioning';
import { generateTemporaryPassword } from './security/password';

const USAGE = `Uso: cli <comando> [opções]

Comandos:
  db:migrate
      Aplica as migrações pendentes com MIGRATION_DATABASE_URL (papel dono do esquema).
  platform:create-admin --email <e-mail> --name <nome>
      Cria um operador da plataforma. A senha vem de CONCILIA_ADMIN_PASSWORD; sem ela,
      é gerada uma senha temporária, exibida uma vez e com troca obrigatória no primeiro acesso.
  tenant:create --slug <slug> --trade-name <nome> --legal-name <razão social> --plan <plano>
                --admin-email <e-mail> --admin-name <nome> [--tax-id <cnpj>] [--active]
      Cria uma empresa com licença, papéis, configurações padrão e o primeiro administrador.
  audit:verify --tenant <slug> | --platform
      Recalcula a cadeia de hashes da trilha de auditoria. Sai com código 2 se estiver quebrada.
  demo:seed
      Monta a empresa fictícia "demo" (Comércio Exemplo Ltda) com usuários, contas, importações e conciliação.
      A senha dos quatro usuários vem de DEMO_PASSWORD (obrigatória). Se a empresa já existir, não altera nada.
`;

type Options = Record<string, string | boolean | undefined>;

class CliError extends Error {}

function required(options: Options, name: string): string {
  const value = options[name];
  if (typeof value !== 'string' || value.trim() === '') throw new CliError(`Informe --${name}.`);
  return value.trim();
}


async function dbMigrate(): Promise<void> {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    throw new CliError('Defina MIGRATION_DATABASE_URL com o papel dono do esquema (nunca o papel da aplicação).');
  }
  const result = await migrate({
    connectionString,
    appRole: process.env.DB_APP_ROLE || 'concilia_app',
    log: (message) => console.log(message),
  });
  console.log(`Migrações aplicadas: ${result.applied.length}; já existentes: ${result.skipped.length}.`);
}

async function withPool<T>(fn: (pool: ReturnType<typeof createPool>, config: ReturnType<typeof loadConfig>) => Promise<T>) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, 2);
  try {
    return await fn(pool, config);
  } finally {
    await pool.end();
  }
}

async function createAdmin(options: Options): Promise<void> {
  const email = required(options, 'email');
  const name = required(options, 'name');
  const given = process.env.CONCILIA_ADMIN_PASSWORD;
  const temporary = given ? null : generateTemporaryPassword();
  await withPool(async (pool, config) => {
    const id = await withContext(pool, { platform: true }, async (db) => {
      const userId = await createPlatformAdmin(db, config, { name, email, password: given ?? (temporary as string) });
      if (temporary) await db.query('UPDATE users SET must_change_password = true WHERE id = $1', [userId]);
      return userId;
    });
    console.log(`Operador da plataforma criado: ${email} (${id}).`);
    if (temporary) console.log(`Senha temporária (exibida uma única vez): ${temporary}`);
  });
}

async function createTenant(options: Options): Promise<void> {
  const input = {
    slug: required(options, 'slug'),
    tradeName: required(options, 'trade-name'),
    legalName: required(options, 'legal-name'),
    planCode: required(options, 'plan'),
    adminEmail: required(options, 'admin-email'),
    adminName: required(options, 'admin-name'),
    taxId: typeof options['tax-id'] === 'string' ? options['tax-id'].replace(/\D/g, '') || null : null,
  };
  await withPool(async (pool, config) => {
    const result = await withContext(pool, { platform: true }, (db) =>
      provisionTenant(db, config, {
        slug: input.slug,
        legalName: input.legalName,
        tradeName: input.tradeName,
        taxId: input.taxId,
        planCode: input.planCode,
        status: options.active ? 'active' : 'onboarding',
        admin: { name: input.adminName, email: input.adminEmail },
        actor: { type: 'system', id: null, label: 'cli' },
      }),
    );
    console.log(`Empresa criada: ${result.slug} (${result.tenantId}).`);
    console.log(`Administrador: ${input.adminEmail.toLowerCase()}`);
    if (result.temporaryPassword) {
      console.log(`Senha temporária (exibida uma única vez): ${result.temporaryPassword}`);
    }
  });
}

async function demoSeed(): Promise<void> {
  const config = loadConfig();
  const result = await seedDemo(config, process.env.DEMO_PASSWORD);
  if (!result.created) {
    console.log(`A empresa "demo" já existe (${result.tenantId}); nada foi alterado.`);
    return;
  }
  console.log(`Empresa de demonstração criada (${result.tenantId}). Usuários: admin, gestor, analista, auditor @demo.exemplo.test`);
  for (const item of result.imports) console.log(`Importação ${item.file}: ${item.status} ${JSON.stringify(item.stats)}`);
  for (const item of result.accounts) {
    console.log(
      `${item.account}: ${item.autoMatched} automática(s), ${item.suggested} sugestão(ões), ${item.divergences} divergência(s) ${JSON.stringify(item.stats)}`,
    );
  }
}

async function auditVerify(options: Options): Promise<number> {
  const platform = options.platform === true;
  const slug = platform ? null : required(options, 'tenant');
  return withPool(async (pool) => {
    let tenantId: string | null = null;
    if (slug) {
      const found = await withContext(pool, { platform: true }, (db) =>
        db.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug]),
      );
      tenantId = found.rows[0]?.id ?? null;
      if (!tenantId) throw new CliError(`Empresa "${slug}" não encontrada.`);
    }
    const check = await withContext(pool, tenantId ? { tenantId } : { platform: true }, (db) =>
      verifyAuditChain(db, tenantId),
    );
    console.log(JSON.stringify({ scope: slug ?? 'platform', ...check }, null, 2));
    if (!check.intact) {
      console.error(`Cadeia de auditoria quebrada na sequência ${check.brokenSeq}.`);
      return 2;
    }
    return 0;
  });
}

async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      slug: { type: 'string' },
      'trade-name': { type: 'string' },
      'legal-name': { type: 'string' },
      plan: { type: 'string' },
      'admin-email': { type: 'string' },
      'admin-name': { type: 'string' },
      'tax-id': { type: 'string' },
      active: { type: 'boolean' },
      tenant: { type: 'string' },
      platform: { type: 'boolean' },
    },
    strict: true,
  });
  switch (command) {
    case 'db:migrate':
      await dbMigrate();
      return 0;
    case 'platform:create-admin':
      await createAdmin(values);
      return 0;
    case 'tenant:create':
      await createTenant(values);
      return 0;
    case 'demo:seed':
      await demoSeed();
      return 0;
    case 'audit:verify':
      return auditVerify(values);
    default:
      console.log(USAGE);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 1;
  }
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof CliError || error instanceof DemoSeedError || error instanceof ConfigError || error instanceof AppError) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exit(1);
  },
);
