import { importProfileConfigSchema } from '@concilia/core';
import { buildApp } from '../app';
import type { Config } from '../config/env';
import { withContext } from '../db/context';
import { runPendingJobs } from '../jobs/worker';
import { provisionTenant } from '../modules/tenancy/provisioning';
import { passwordProblem } from '../security/password';
import { DemoClient } from './client';
import { buildDemoFiles } from './files';

// Todos os dados são FICTÍCIOS.
export const DEMO_SLUG = 'demo';
const DOMAIN = 'demo.exemplo.test';
const USERS = [
  { role: 'gestor', name: 'Gestor Demonstração' },
  { role: 'analista', name: 'Analista Demonstração' },
  { role: 'auditor', name: 'Auditor Demonstração' },
] as const;

export class DemoSeedError extends Error {}

export interface AccountSummary {
  account: string;
  runId: string;
  autoMatched: number;
  suggested: number;
  divergences: number;
  stats: Record<string, unknown>;
}

export interface ImportSummary {
  file: string;
  status: string;
  stats: Record<string, unknown>;
}

export type SeedResult =
  | { created: false; tenantId: string }
  | { created: true; tenantId: string; imports: ImportSummary[]; accounts: AccountSummary[] };

/** Valida a senha antes de tocar no banco. */
export function demoPasswordProblem(password: string | undefined): string | null {
  if (!password) return 'Defina DEMO_PASSWORD com a senha dos usuários de demonstração.';
  if (password.length < 12) return 'DEMO_PASSWORD deve ter ao menos 12 caracteres.';
  for (const email of ['admin', 'gestor', 'analista', 'auditor']) {
    const problem = passwordProblem(password, { minLength: 12 }, `${email}@${DOMAIN}`);
    if (problem) return `DEMO_PASSWORD fraca: ${problem}`;
  }
  return null;
}

const csvConfig = importProfileConfigSchema.parse({
  delimiter: ';',
  encoding: 'utf-8',
  headerRow: 1,
  dateFormat: 'DD/MM/YYYY',
  decimalSeparator: ',',
  amountMode: 'signed',
  columns: { date: 'Data', description: ['Histórico'], amount: 'Valor', document: 'Documento' },
});

const xlsxConfig = importProfileConfigSchema.parse({
  headerRow: 1,
  dateFormat: 'auto',
  amountMode: 'signed',
  columns: {
    date: 'Data Pagamento',
    description: ['Descrição'],
    amount: 'Valor',
    document: 'Documento',
    counterparty: 'Favorecido',
    dueDate: 'Vencimento',
    externalId: 'ID',
    bankAccountRef: 'Conta',
  },
});

/** Monta a empresa de demonstração pelos mesmos serviços e rotas da aplicação. Idempotente. */
export async function seedDemo(baseConfig: Config, password: string | undefined): Promise<SeedResult> {
  const problem = demoPasswordProblem(password);
  if (problem || !password) throw new DemoSeedError(problem ?? 'Senha ausente.');

  const config: Config = { ...baseConfig, workerEnabled: false, rateLimitEnabled: false };
  const app = await buildApp(config);
  try {
    const pool = app.deps.pool;
    const existing = await withContext(pool, { platform: true }, (db) =>
      db.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [DEMO_SLUG]),
    );
    if (existing.rows[0]) return { created: false, tenantId: existing.rows[0].id };

    const provisioned = await withContext(pool, { platform: true }, (db) =>
      provisionTenant(db, config, {
        slug: DEMO_SLUG,
        legalName: 'Comércio Exemplo Ltda',
        tradeName: 'Comércio Exemplo Ltda',
        taxId: null,
        planCode: 'corporativo',
        status: 'active',
        admin: { name: 'Administrador Demonstração', email: `admin@${DOMAIN}`, password },
        actor: { type: 'system', id: null, label: 'cli demo:seed' },
      }),
    );

    const api = new DemoClient(app);
    await api.login(`admin@${DOMAIN}`, password);

    // Usuários
    const roles = (await api.expect(200, api.get('/roles'), 'Listar papéis')).items as { id: string; key: string }[];
    for (const user of USERS) {
      const role = roles.find((entry) => entry.key === user.role);
      if (!role) throw new DemoSeedError(`Papel ${user.role} não encontrado.`);
      await api.expect(
        201,
        api.post('/users', { name: user.name, email: `${user.role}@${DOMAIN}`, roleId: role.id, password }),
        `Criar usuário ${user.role}`,
      );
    }

    // Módulos e configurações
    for (const key of ['approvals', 'grouping', 'transfers']) {
      await api.expect(200, api.put(`/modules/${key}`, { enabled: true }), `Habilitar módulo ${key}`);
    }
    await api.expect(200, api.put('/settings', { patch: { approvals: { enabled: true, fourEyes: true } } }), 'Ativar aprovações');

    // Contas, plano de contas e perfis
    const movimento = await api.expect(
      201,
      api.post('/bank-accounts', { name: 'Conta Movimento', bankCode: '0999', branch: '0001', accountNumber: '12345-6', externalRef: 'MOVIMENTO' }),
      'Criar Conta Movimento',
    );
    const reserva = await api.expect(
      201,
      api.post('/bank-accounts', { name: 'Conta Reserva', bankCode: '0999', branch: '0001', accountNumber: '67890-1', externalRef: 'RESERVA' }),
      'Criar Conta Reserva',
    );
    await api.expect(200, api.post('/onboarding/apply-template', { template: 'plano-de-contas-basico' }), 'Aplicar plano de contas');
    const csvProfile = await api.expect(
      201,
      api.post('/import-profiles', { name: 'Extrato Reserva (CSV)', sourceKind: 'bank', fileFormat: 'csv', config: csvConfig }),
      'Criar perfil CSV',
    );
    const xlsxProfile = await api.expect(
      201,
      api.post('/import-profiles', { name: 'Lançamentos (XLSX)', sourceKind: 'ledger', fileFormat: 'xlsx', config: xlsxConfig }),
      'Criar perfil XLSX',
    );

    // Importações, na ordem dos arquivos
    const imports: ImportSummary[] = [];
    for (const file of await buildDemoFiles()) {
      const accountId = file.account === 'movimento' ? movimento.id : file.account === 'reserva' ? reserva.id : undefined;
      const profileId = file.name.endsWith('.csv') ? csvProfile.id : file.name.endsWith('.xlsx') ? xlsxProfile.id : undefined;
      const uploaded = await api.expect(
        201,
        api.upload({ sourceKind: file.kind, bankAccountId: accountId, profileId }, { name: file.name, content: file.content }),
        `Enviar ${file.name}`,
      );
      await api.expect(202, api.post(`/imports/${uploaded.id}/confirm`, profileId ? { profileId } : {}), `Confirmar ${file.name}`);
      await runPendingJobs(app.deps);
      const batch = await api.expect(200, api.get(`/imports/${uploaded.id}`), `Consultar ${file.name}`);
      imports.push({ file: file.name, status: batch.status, stats: batch.stats });
      if (batch.status !== 'completed') throw new DemoSeedError(`Importação de ${file.name} terminou como ${batch.status}.`);
    }

    // Conciliação de janeiro de 2024
    const accounts: AccountSummary[] = [];
    for (const [name, id] of [['Conta Movimento', movimento.id], ['Conta Reserva', reserva.id]] as const) {
      const queued = await api.expect(
        202,
        api.post('/reconciliation/runs', { bankAccountId: id, periodStart: '2024-01-01', periodEnd: '2024-01-31' }),
        `Conciliar ${name}`,
      );
      await runPendingJobs(app.deps);
      const run = await api.expect(200, api.get(`/reconciliation/runs/${queued.runId}`), `Consultar conciliação de ${name}`);
      if (run.status !== 'completed') throw new DemoSeedError(`Conciliação de ${name} terminou como ${run.status}.`);
      accounts.push({
        account: name,
        runId: queued.runId,
        autoMatched: Number(run.stats.autoMatched ?? 0),
        suggested: Number(run.stats.suggested ?? 0),
        divergences: Number(run.stats.divergences ?? 0),
        stats: run.stats,
      });
    }
    return { created: true, tenantId: provisioned.tenantId, imports, accounts };
  } finally {
    await app.close();
  }
}
