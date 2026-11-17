import { beforeAll, describe, expect, it } from 'vitest';
import { demoPasswordProblem, seedDemo, type SeedResult } from '../../src/demo/seed';
import { testConfig } from '../helpers/app';
import { ownerPool } from '../helpers/db';

const PASSWORD = 'Demonstracao-Segura-2024';

interface MatchRow {
  match_type: string;
  status: string;
  auto_confirmed: boolean;
  ambiguous: boolean;
  divergence: string | null;
  rule_code: string;
  bank: string[] | null;
  ledger: string[] | null;
  bank_status: string[] | null;
}

describe('demo:seed', () => {
  let result: Extract<SeedResult, { created: true }>;
  let tenantId: string;
  let matches: MatchRow[];

  const withBank = (text: string) => matches.filter((m) => m.bank?.some((b) => b.includes(text)));

  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of ['users', 'bank_accounts', 'import_batches', 'bank_transactions', 'ledger_entries', 'matches', 'reconciliation_runs', 'audit_log', 'jobs']) {
      const r = await ownerPool().query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      out[table] = r.rows[0].n;
    }
    return out;
  }

  beforeAll(async () => {
    const first = await seedDemo(testConfig(), PASSWORD);
    if (!first.created) throw new Error('a empresa demo já existia no banco de testes');
    result = first;
    tenantId = first.tenantId;
    const rows = await ownerPool().query<MatchRow>(
      `SELECT m.match_type, m.status, m.auto_confirmed, m.ambiguous, m.divergence, m.rule_code,
              array_agg(b.description_raw || ' ' || b.amount_cents) FILTER (WHERE b.id IS NOT NULL) AS bank,
              array_agg(b.recon_status) FILTER (WHERE b.id IS NOT NULL) AS bank_status,
              array_agg(l.description_raw || ' ' || l.amount_cents) FILTER (WHERE l.id IS NOT NULL) AS ledger
         FROM matches m
         JOIN match_items i ON i.match_id = m.id
         LEFT JOIN bank_transactions b ON b.id = i.bank_transaction_id
         LEFT JOIN ledger_entries l ON l.id = i.ledger_entry_id
        WHERE m.tenant_id = $1 GROUP BY m.id`,
      [tenantId],
    );
    matches = rows.rows;
  }, 120_000);

  it('recusa senha ausente ou fraca', async () => {
    expect(demoPasswordProblem(undefined)).toMatch(/DEMO_PASSWORD/);
    expect(demoPasswordProblem('curta')).toMatch(/12/);
    expect(demoPasswordProblem('aaaaaaaaaaaaaaaa')).toMatch(/fraca/);
    expect(demoPasswordProblem('adminadminadmin1')).toMatch(/fraca/);
    expect(demoPasswordProblem(PASSWORD)).toBeNull();
    await expect(seedDemo(testConfig(), undefined)).rejects.toThrow(/DEMO_PASSWORD/);
  });

  it('provisiona empresa, usuários, contas e configurações', async () => {
    const tenant = await ownerPool().query(`SELECT slug, trade_name, status FROM tenants WHERE id = $1`, [tenantId]);
    expect(tenant.rows[0]).toEqual({ slug: 'demo', trade_name: 'Comércio Exemplo Ltda', status: 'active' });
    const users = await ownerPool().query(`SELECT u.email, r.key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $1 ORDER BY 1`, [tenantId]);
    expect(users.rows).toEqual([
      { email: 'admin@demo.exemplo.test', key: 'admin' },
      { email: 'analista@demo.exemplo.test', key: 'analista' },
      { email: 'auditor@demo.exemplo.test', key: 'auditor' },
      { email: 'gestor@demo.exemplo.test', key: 'gestor' },
    ]);
    const accounts = await ownerPool().query(`SELECT name, bank_code, external_ref FROM bank_accounts WHERE tenant_id = $1 ORDER BY name`, [tenantId]);
    expect(accounts.rows).toEqual([
      { name: 'Conta Movimento', bank_code: '0999', external_ref: 'MOVIMENTO' },
      { name: 'Conta Reserva', bank_code: '0999', external_ref: 'RESERVA' },
    ]);
    const modules = await ownerPool().query(`SELECT module_key FROM tenant_modules WHERE tenant_id = $1 AND enabled`, [tenantId]);
    expect(modules.rows.map((r) => r.module_key)).toEqual(expect.arrayContaining(['approvals', 'grouping', 'transfers']));
    const settings = await ownerPool().query(`SELECT data->'approvals'->>'enabled' AS enabled FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
    expect(settings.rows[0].enabled).toBe('true');
    const chart = await ownerPool().query(`SELECT count(*)::int AS n FROM chart_accounts WHERE tenant_id = $1`, [tenantId]);
    expect(chart.rows[0].n).toBeGreaterThan(0);
  });

  it('importa os quatro arquivos sem rejeições e sem duplicar o complemento', () => {
    expect(result.imports.map((i) => i.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(result.imports.map((i) => [i.stats.imported, i.stats.rejected, i.stats.conflicts])).toEqual([
      [37, 0, 0],
      [3, 0, 0],
      [5, 0, 0],
      [34, 0, 0],
    ]);
    expect(result.imports[1]?.stats).toMatchObject({ totalRows: 12, duplicates: 9 });
  });

  it('o complemento acrescentou só as 3 transações novas', async () => {
    const r = await ownerPool().query(
      `SELECT count(*)::int AS n FROM bank_transactions t JOIN bank_accounts a ON a.id = t.bank_account_id
        WHERE t.tenant_id = $1 AND a.external_ref = 'MOVIMENTO'`,
      [tenantId],
    );
    expect(r.rows[0].n).toBe(40);
  });

  it('concilia automaticamente os pares com mesmo documento e valor', () => {
    const auto = matches.filter((m) => m.rule_code === 'ID_VALOR');
    expect(auto).toHaveLength(20);
    expect(auto.every((m) => m.status === 'confirmed' && m.auto_confirmed)).toBe(true);
    expect(result.accounts[0]?.autoMatched).toBe(25);
  });

  it('deixa os dois recebimentos de R$ 750,00 como sugestões ambíguas, não conciliados', () => {
    const avulsos = withBank('CLIENTE AVULSO');
    expect(avulsos.length).toBeGreaterThan(0);
    for (const m of avulsos) {
      expect(m).toMatchObject({ status: 'suggested', ambiguous: true, auto_confirmed: false });
      expect(m.bank_status).toEqual(['pending']);
    }
  });

  it('a NF 4520 gera divergência de valor', () => {
    const [m] = withBank('NF 4520');
    expect(m).toMatchObject({ divergence: 'amount', status: 'suggested' });
    expect(m?.bank_status).toEqual(['divergent']);
    expect(result.accounts[0]?.divergences).toBe(1);
  });

  it('sugere agrupamento para o depósito de R$ 3.600,00', () => {
    const [m] = withBank('DEP LOTE CARTOES');
    expect(m).toMatchObject({ match_type: 'group', status: 'suggested' });
    expect(m?.ledger).toHaveLength(3);
  });

  it('sugere classificação para as três tarifas', () => {
    for (const text of ['TARIFA PACOTE SERVICOS', 'TAR PIX', 'IOF']) {
      const found = matches.filter((m) => m.match_type === 'classification' && m.bank?.some((b) => b.startsWith(`${text} -`)));
      expect(found, text).toHaveLength(1);
      expect(found[0]?.status).toBe('suggested');
    }
  });

  it('pareia o estorno e sugere a transferência entre contas', () => {
    const [estorno] = withBank('ESTORNO PAGTO BOLETO ENERGIA');
    expect(estorno).toMatchObject({ match_type: 'reversal', status: 'suggested' });
    const [transfer] = withBank('TRANSF ENTRE CONTAS');
    expect(transfer).toMatchObject({ match_type: 'internal_transfer', status: 'suggested' });
    expect(transfer?.bank).toHaveLength(2);
  });

  it('rodar o seed de novo informa e não altera nada', async () => {
    const before = await counts();
    const again = await seedDemo(testConfig(), PASSWORD);
    expect(again).toEqual({ created: false, tenantId });
    expect(await counts()).toEqual(before);
  });
});
