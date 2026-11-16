import { expect, loginAs, test } from '../support/fixtures';

test.describe('6. Auditoria', () => {
  test('as ações dos cenários anteriores aparecem e a cadeia está íntegra', async ({ page }) => {
    await loginAs(page, 'auditor');
    await page.getByRole('navigation', { name: 'Menu principal' }).getByRole('link', { name: 'Auditoria' }).click();
    await expect(page.getByRole('heading', { name: 'Auditoria', level: 1 })).toBeVisible();

    const tabela = page.getByRole('table', { name: 'Registros de auditoria' });
    await expect(tabela.getByRole('row').nth(1)).toBeVisible();

    const filtros = page.getByRole('form', { name: 'Filtros da auditoria' });
    for (const acao of [
      'reconciliation.match_accepted',
      'reconciliation.match_rejected',
      'reconciliation.match_manual',
      'reconciliation.match_approved',
      'reconciliation.match_refused',
      'reconciliation.match_undone',
      'export.created',
    ]) {
      await filtros.getByLabel('Ação').fill(acao);
      await filtros.getByRole('button', { name: 'Filtrar' }).click();
      await expect(tabela.getByRole('cell', { name: acao, exact: true }).first(), acao).toBeVisible();
    }

    // Detalhe de um registro
    await tabela.getByRole('row').nth(1).click();
    const gaveta = page.getByRole('dialog', { name: /^Registro \d+/ });
    await expect(gaveta.getByText('Hash', { exact: true })).toBeVisible();
    await gaveta.getByRole('button', { name: 'Fechar' }).click();

    await filtros.getByRole('button', { name: 'Limpar' }).click();
    await page.getByRole('button', { name: 'Verificar integridade' }).click();
    const verificacao = page.getByRole('dialog', { name: 'Verificação de integridade' });
    await expect(verificacao.getByText('Cadeia íntegra')).toBeVisible();
    await expect(verificacao.getByText('Registros verificados')).toBeVisible();
  });
});
