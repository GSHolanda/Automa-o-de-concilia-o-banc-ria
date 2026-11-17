import { readFile } from 'node:fs/promises';
import { expect, loginAs, test } from '../support/fixtures';

test.describe('5. Relatórios', () => {
  test('exporta itens em CSV e baixa um arquivo com conteúdo', async ({ page }) => {
    await loginAs(page, 'analista');
    await page.getByRole('navigation', { name: 'Menu principal' }).getByRole('link', { name: 'Relatórios' }).click();
    await expect(page.getByRole('heading', { name: 'Relatórios', level: 1 })).toBeVisible();

    const itens = page.getByRole('region', { name: 'Itens' });
    await itens.getByLabel('Formato').selectOption('csv');
    await itens.getByLabel('Origem').selectOption({ label: 'Extrato' });
    const downloadPromise = page.waitForEvent('download');
    await itens.getByRole('button', { name: 'Gerar arquivo de itens' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const caminho = await download.path();
    const texto = (await readFile(caminho, 'utf8')).replace(/^﻿/, '');
    const linhas = texto.trim().split(/\r?\n/);
    expect(linhas.length).toBeGreaterThan(30);
    expect(texto).toContain('DEP LOTE CARTOES');
    await expect(page.getByRole('region', { name: 'Notificações' })).toContainText('Arquivo gerado');
  });

  test('a exportação fica registrada na auditoria', async ({ page }) => {
    await loginAs(page, 'auditor');
    const resposta = await page.request.get('/api/v1/audit?action=export.created&limit=5');
    expect(resposta.status()).toBe(200);
    expect(((await resposta.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });
});
