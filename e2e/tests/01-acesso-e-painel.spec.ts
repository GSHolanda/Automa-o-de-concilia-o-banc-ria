import { expect, loginAs, test, logout, demoEmail, login } from '../support/fixtures';

interface Summary { count: number; amountCents: number }
interface Dashboard {
  bank: Record<string, Summary>;
  ledger: Record<string, Summary>;
  openSuggestions: number;
  pendingApprovals: number;
}

test.describe('1. Acesso e painel', () => {
  test('login do analista e painel coerente com os dados da API', async ({ page }) => {
    await loginAs(page, 'analista');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Painel', level: 1 })).toBeVisible();

    await page.getByLabel('De').fill('2024-01-01');
    await page.getByLabel('Até').fill('2024-01-31');
    const dash = await page.request.get('/api/v1/dashboard?dateFrom=2024-01-01&dateTo=2024-01-31');
    expect(dash.status()).toBe(200);
    const data = (await dash.json()) as Dashboard;
    expect(data.bank.total!.count).toBeGreaterThan(30);
    expect(data.ledger.total!.count).toBeGreaterThan(30);

    const extrato = page.getByRole('region', { name: 'Extrato bancário' });
    await expect(extrato.getByRole('link', { name: new RegExp(`Pendentes\\s*${data.bank.pending!.count}\\b`) })).toBeVisible();
    await expect(extrato.getByRole('link', { name: new RegExp(`Conciliados\\s*${data.bank.reconciled!.count}\\b`) })).toBeVisible();
    const lancamentos = page.getByRole('region', { name: 'Lançamentos', exact: true });
    await expect(lancamentos.getByRole('link', { name: new RegExp(`Conciliados\\s*${data.ledger.reconciled!.count}\\b`) })).toBeVisible();
    const indicadores = page.getByRole('region', { name: 'Indicadores' });
    await expect(indicadores.getByText('Sugestões aguardando revisão').locator('..').locator('.qtd')).toHaveText(String(data.openSuggestions));
    expect(data.openSuggestions).toBeGreaterThan(0);

    // A soma das situações é o total.
    const sum = (side: Record<string, Summary>) =>
      ['reconciled', 'pending', 'divergent', 'ignored', 'awaitingApproval'].reduce((t, k) => t + (side[k]?.count ?? 0), 0);
    expect(sum(data.bank)).toBe(data.bank.total!.count);
    expect(sum(data.ledger)).toBe(data.ledger.total!.count);
  });

  test('o menu respeita as permissões de cada papel', async ({ page }) => {
    const menu = page.getByRole('navigation', { name: 'Menu principal' });

    await loginAs(page, 'analista');
    for (const item of ['Painel', 'Importações', 'Conciliação', 'Relatórios']) {
      await expect(menu.getByRole('link', { name: item })).toBeVisible();
    }
    await expect(menu.getByRole('link', { name: /^Aprovações/ })).toHaveCount(0);
    await page.goto('/aprovacoes');
    await expect(page.getByRole('heading', { name: 'Aprovações', level: 1 })).toHaveCount(0);
    await logout(page);

    await loginAs(page, 'auditor');
    await expect(menu.getByRole('link', { name: 'Auditoria' })).toBeVisible();
    await expect(menu.getByRole('link', { name: /^Aprovações/ })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: 'Configurações' })).toBeVisible();
    await page.goto('/configuracoes/usuarios');
    await expect(page.getByRole('heading', { name: 'Usuários', level: 1 })).toHaveCount(0);
    await page.goto('/configuracoes');
    await expect(page.getByRole('link', { name: 'Usuários' })).toHaveCount(0);
    await logout(page);

    await loginAs(page, 'gestor');
    await expect(menu.getByRole('link', { name: /^Aprovações/ })).toBeVisible();
    await logout(page);

    await loginAs(page, 'admin');
    await page.goto('/configuracoes');
    await expect(page.getByRole('link', { name: 'Usuários' })).toBeVisible();
  });

  test('credenciais inválidas mostram erro sem sair da tela', async ({ page, problems }) => {
    problems.tolerate({ status: 401, url: /\/auth\/login$/ });
    await login(page, demoEmail('analista'), 'senha-errada-123');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/entrar/);
  });
});
