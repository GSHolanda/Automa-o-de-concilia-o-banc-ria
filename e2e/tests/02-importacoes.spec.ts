import { expect, loginAs, test } from '../support/fixtures';

interface Batch { id: string; fileName: string; sourceKind: string; status: string }

test.describe('2. Importações', () => {
  test('lista os lotes do seed, abre o detalhe e avisa sobre arquivo já importado', async ({ page, problems }) => {
    problems.tolerate({ status: 409, url: /\/api\/v1\/imports$/ });
    await loginAs(page, 'analista');
    await page.getByRole('navigation', { name: 'Menu principal' }).getByRole('link', { name: 'Importações' }).click();
    await expect(page.getByRole('heading', { name: 'Importações', level: 1 })).toBeVisible();

    const tabela = page.getByRole('table', { name: 'Lotes de importação' });
    for (const arquivo of [
      'extrato-movimento-2024-01.ofx',
      'extrato-movimento-2024-01-complemento.ofx',
      'extrato-reserva-2024-01.csv',
      'lancamentos-2024-01.xlsx',
    ]) {
      await expect(tabela.getByRole('link', { name: arquivo })).toBeVisible();
    }
    await expect(tabela.getByRole('row').filter({ hasText: 'lancamentos-2024-01.xlsx' })).toContainText('Concluída');

    // Detalhe do lote
    await tabela.getByRole('link', { name: 'extrato-movimento-2024-01.ofx', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'extrato-movimento-2024-01.ofx', level: 1 })).toBeVisible();
    await expect(page.getByText('Duplicados', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Baixar/ })).toBeVisible();

    // Reenvio do mesmo arquivo (bytes idênticos aos do lote original)
    const lista = await (await page.request.get('/api/v1/imports?limit=50')).json();
    const original = (lista.items as Batch[]).find((b) => b.fileName === 'extrato-movimento-2024-01.ofx')!;
    const bytes = await (await page.request.get(`/api/v1/imports/${original.id}/file`)).body();
    expect(bytes.length).toBeGreaterThan(100);

    await page.goto('/importacoes/nova');
    await expect(page.getByRole('heading', { name: 'Nova importação', level: 1 })).toBeVisible();
    await page.getByLabel('Conta bancária').selectOption({ label: 'Conta Movimento' });
    await page.locator('input[type=file]').setInputFiles({ name: 'extrato-movimento-2024-01.ofx', mimeType: 'application/x-ofx', buffer: bytes });
    await page.getByRole('button', { name: 'Enviar e pré-visualizar' }).click();
    const aviso = page.getByRole('alert').filter({ hasText: 'já foi importado' });
    await expect(aviso).toBeVisible();
    await aviso.getByRole('link', { name: 'Ver o lote existente' }).click();
    await expect(page).toHaveURL(new RegExp(`/importacoes/${original.id}$`));
  });
});
