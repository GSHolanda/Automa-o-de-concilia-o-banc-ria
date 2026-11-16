import type { Page } from '@playwright/test';
import { expect, loginAs, logout, test } from '../support/fixtures';

const toast = (page: Page) => page.getByRole('region', { name: 'Notificações' });

test.describe('4. Desfazer conciliação', () => {
  test('o gestor desfaz com motivo e o item volta a Pendentes; o analista não vê a ação', async ({ page }) => {
    await loginAs(page, 'analista');
    await page.goto('/conciliacao?aba=conciliados');
    const tabela = page.getByRole('table', { name: 'Itens de Extrato' });
    await expect(tabela.getByRole('row').nth(1)).toBeVisible();
    await expect(tabela.getByRole('button', { name: 'Desfazer' })).toHaveCount(0);
    await logout(page);

    await loginAs(page, 'gestor');
    await page.goto('/conciliacao?aba=conciliados');
    const linha = tabela.getByRole('row').nth(1);
    await expect(linha).toBeVisible();
    const descricao = (await linha.locator('.conc-desc').innerText()).trim();
    const valor = (await linha.locator('td').nth(2).innerText()).trim();
    await linha.getByRole('button', { name: 'Desfazer' }).click();

    const dialogo = page.getByRole('dialog', { name: 'Desfazer conciliação' });
    await dialogo.getByRole('button', { name: 'Desfazer' }).click();
    await expect(dialogo.getByText('Informe o motivo.')).toBeVisible();
    await dialogo.getByLabel('Motivo').fill('Conciliado com o par errado');
    await dialogo.getByRole('button', { name: 'Desfazer' }).click();
    await expect(toast(page)).toContainText('Conciliação desfeita.');
    await expect(dialogo).toBeHidden();

    // O item volta para a fila de pendentes.
    await page.goto('/conciliacao?aba=pendentes');
    await page.getByLabel('Pesquisar').fill(descricao);
    const pendentes = page.getByRole('table', { name: 'Itens de Extrato' });
    await expect(pendentes.getByRole('row').filter({ hasText: descricao }).filter({ hasText: valor }).first()).toBeVisible();

    // E a decisão aparece no histórico do item.
    await pendentes.getByRole('row').filter({ hasText: descricao }).filter({ hasText: valor }).first().click();
    const gaveta = page.getByRole('dialog', { name: 'Detalhe do item' });
    await expect(gaveta.getByText('Desfeita: Conciliado com o par errado')).toBeVisible();
  });
});
