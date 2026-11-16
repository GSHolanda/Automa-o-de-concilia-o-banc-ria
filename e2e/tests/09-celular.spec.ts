import { captura, expect, expectNoHorizontalScroll, login, demoEmail, test } from '../support/fixtures';

test.use({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

test.describe('9. Celular (360 × 740)', () => {
  test('login, painel e conciliação sem rolagem horizontal e com menu em gaveta', async ({ page }) => {
    await page.goto('/entrar');
    await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);

    await login(page, demoEmail('gestor'));
    await expect(page.getByRole('heading', { name: 'Painel', level: 1 })).toBeVisible();
    await page.getByLabel('De', { exact: true }).fill('2024-01-01');
    await page.getByLabel('Até', { exact: true }).fill('2024-01-31');
    await expect(page.getByRole('region', { name: 'Extrato bancário' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoHorizontalScroll(page);

    // O menu fica fechado e fora da tela até abrir a gaveta
    const menu = page.getByRole('navigation', { name: 'Menu principal' });
    const abrir = page.getByRole('button', { name: 'Abrir menu' });
    await expect(abrir).toBeVisible();
    await expect(abrir).toHaveAttribute('aria-expanded', 'false');
    expect((await menu.boundingBox())!.x + (await menu.boundingBox())!.width).toBeLessThanOrEqual(1);

    await abrir.click();
    await expect(abrir).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await menu.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    await expectNoHorizontalScroll(page);
    await menu.getByRole('link', { name: 'Conciliação' }).click();

    // Navegar fecha a gaveta
    await expect(page.getByRole('heading', { name: 'Conciliação', level: 1 })).toBeVisible();
    await expect(abrir).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('article').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoHorizontalScroll(page);
    // Espera a gaveta terminar de fechar (transição) antes de capturar
    await expect.poll(async () => { const b = await menu.boundingBox(); return b ? b.x + b.width : -1; }).toBeLessThanOrEqual(1);
    await captura(page, 'conciliacao-celular');

    // Esc fecha a gaveta
    await abrir.click();
    await expect(abrir).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(abrir).toHaveAttribute('aria-expanded', 'false');

    // Outras telas principais também cabem na largura
    for (const rota of ['/conciliacao?aba=pendentes', '/conciliacao?aba=conciliados', '/importacoes', '/aprovacoes', '/auditoria']) {
      await page.goto(rota);
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalScroll(page);
    }
  });
});
