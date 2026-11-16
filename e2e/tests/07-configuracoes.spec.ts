import { expect, loginAs, test } from '../support/fixtures';

test.describe('7. Configurações (administrador)', () => {
  test('todas as telas de /configuracoes abrem sem erro', async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, 'admin');
    await page.getByRole('navigation', { name: 'Menu principal' }).getByRole('link', { name: 'Configurações' }).click();
    await expect(page.getByRole('heading', { name: 'Configurações', level: 1 })).toBeVisible();

    const cartoes = page.locator('main ul a');
    await expect(cartoes.first()).toBeVisible();
    const destinos = await cartoes.evaluateAll((links) =>
      links.map((a) => ({ href: (a as HTMLAnchorElement).getAttribute('href') ?? '', nome: (a.textContent ?? '').trim() })),
    );
    expect(destinos.length).toBeGreaterThanOrEqual(19);

    for (const { href, nome } of destinos) {
      await page.goto(href);
      await expect(page.getByRole('heading', { name: nome, level: 1 }), `título de ${href}`).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('alert'), `alertas em ${href}`).toHaveCount(0);
      await expect(page.getByText(/Não foi possível|Falha na requisição|Erro inesperado/), `mensagem de falha em ${href}`).toHaveCount(0);
    }
  });

  test('cria um centro de custo', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/configuracoes/estrutura');
    await page.getByRole('tab', { name: 'Centros de custo' }).click();
    await page.getByRole('button', { name: 'Novo centro de custo' }).first().click();
    const dialogo = page.getByRole('dialog', { name: 'Novo centro de custo' });
    await dialogo.getByLabel('Código').fill('CC-ADM');
    await dialogo.getByLabel('Nome').fill('Administrativo');
    await dialogo.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByRole('region', { name: 'Notificações' })).toContainText('Centro de custo criado.');
    await expect(page.getByRole('table').getByRole('row').filter({ hasText: 'Administrativo' })).toContainText('CC-ADM');
    await page.reload();
    await page.getByRole('tab', { name: 'Centros de custo' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Administrativo' })).toBeVisible();
  });

  test('altera a tolerância de data e a mudança persiste', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/configuracoes/regras');
    const campo = page.getByLabel('Tolerância de data (dias)', { exact: true });
    await expect(campo).toHaveValue('2');
    await campo.fill('4');
    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(page.getByRole('region', { name: 'Notificações' })).toContainText('Configurações salvas.');
    await page.reload();
    await expect(page.getByLabel('Tolerância de data (dias)', { exact: true })).toHaveValue('4');
    const config = await (await page.request.get('/api/v1/settings')).json();
    expect(config.settings.reconciliation.dateToleranceDays).toBe(4);

    // Valor fora da faixa é recusado na tela
    await page.getByLabel('Tolerância de data (dias)', { exact: true }).fill('99');
    await expect(page.getByText('Use um valor entre 0 e 30.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Salvar alterações' })).toBeDisabled();
  });
});
