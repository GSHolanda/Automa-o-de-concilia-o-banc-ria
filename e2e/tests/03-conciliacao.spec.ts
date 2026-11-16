import type { Page } from '@playwright/test';
import { apiItems, captura, expect, loginAs, logout, test } from '../support/fixtures';

// Estes testes seguem o mesmo fluxo e dependem uns dos outros (nesta ordem).
test.describe.configure({ mode: 'serial' });
test.use({ deviceScaleFactor: 2 });

interface Item { side: 'bank' | 'ledger'; id: string; description: string; amountCents: number; status: string; openSuggestions: number }

const toast = (page: Page) => page.getByRole('region', { name: 'Notificações' });
const tab = (page: Page, nome: string) => page.getByRole('tab', { name: new RegExp(`^${nome}`) });

async function contagem(page: Page, nome: string): Promise<number> {
  const texto = (await tab(page, nome).innerText()).replace(/\D/g, '');
  return Number(texto);
}

/** Um par pendente sem sugestão, do mesmo sinal, com descrições que aparecem uma só vez (a diferença exige nota). */
async function parPendente(page: Page, excluir: string[] = []): Promise<{ extrato: Item; lancamento: Item }> {
  const bank = await apiItems<Item>(page, '/reconciliation/items?side=bank&status=pending');
  const ledger = await apiItems<Item>(page, '/reconciliation/items?side=ledger&status=pending');
  const unica = (lista: Item[], item: Item) =>
    lista.filter((x) => x.description.includes(item.description) || item.description.includes(x.description)).length === 1;
  const livre = (lista: Item[]) => lista.filter((i) => i.openSuggestions === 0 && unica(lista, i) && !excluir.includes(i.id));
  for (const extrato of livre(bank)) {
    const lancamento = livre(ledger).find((l) => Math.sign(l.amountCents) === Math.sign(extrato.amountCents));
    if (lancamento) return { extrato, lancamento };
  }
  throw new Error('Nenhum par pendente disponível');
}

async function marcar(page: Page, tabela: string, descricao: string): Promise<void> {
  const linha = page.getByRole('table', { name: tabela }).getByRole('row').filter({ hasText: descricao });
  await linha.getByRole('checkbox', { name: 'Selecionar linha' }).check();
}

async function proporManual(page: Page, par: { extrato: Item; lancamento: Item }): Promise<void> {
  await page.goto('/conciliacao?aba=pendentes');
  await marcar(page, 'Itens de Extrato', par.extrato.description);
  await marcar(page, 'Itens de Lançamentos', par.lancamento.description);
  const barra = page.getByRole('region', { name: 'Conciliação manual' });
  await expect(barra).toContainText('Diferença');
  const nota = barra.getByLabel('Nota (obrigatória com diferença)');
  if (await nota.isVisible()) {
    await barra.getByRole('button', { name: 'Conciliar selecionados' }).click();
    await expect(barra.getByText('Explique a diferença.')).toBeVisible();
    await nota.fill('Diferença conferida com o extrato');
  }
  await barra.getByRole('button', { name: 'Conciliar selecionados' }).click();
  await expect(toast(page)).toContainText('aguarda aprovação');
}

const estado: { aceita?: string; analista?: { extrato: Item; lancamento: Item }; gestor?: { extrato: Item; lancamento: Item } } = {};

test.describe('3. Conciliação e aprovação', () => {
  test('aba Sugestões lista as sugestões e mostra as contagens do servidor', async ({ page }) => {
    await loginAs(page, 'analista');
    await page.getByRole('navigation', { name: 'Menu principal' }).getByRole('link', { name: 'Conciliação' }).click();
    await expect(page.getByRole('heading', { name: 'Conciliação', level: 1 })).toBeVisible();
    await expect(tab(page, 'Sugestões')).toHaveAttribute('aria-selected', 'true');

    const cartoes = page.getByRole('article');
    await expect(cartoes.first()).toBeVisible();
    const sugestoes = await apiItems<{ id: string }>(page, '/reconciliation/matches?status=suggested');
    await expect(cartoes).toHaveCount(sugestoes.length);
    expect(await contagem(page, 'Sugestões')).toBe(sugestoes.length);

    const counts = await (await page.request.get('/api/v1/reconciliation/counts')).json();
    expect(counts.suggestions).toBe(sugestoes.length);
    for (const [nome, chave] of [['Pendentes', 'pending'], ['Divergentes', 'divergent'], ['Conciliados', 'reconciled'], ['Ignorados', 'ignored']] as const) {
      expect(await contagem(page, nome)).toBe(counts[chave]);
      await expect(tab(page, nome)).not.toContainText('+');
    }
    await page.getByRole('heading', { name: 'Conciliação', level: 1 }).click();
    await captura(page, 'conciliacao');
  });

  test('filtros de texto e período valem também para as sugestões', async ({ page }) => {
    await loginAs(page, 'analista');
    await page.goto('/conciliacao');
    await expect(tab(page, 'Sugestões').locator('.aba-contagem')).toBeVisible();
    const total = await contagem(page, 'Sugestões');
    await page.getByLabel('Pesquisar').fill('texto-que-nao-existe-xyz');
    await expect(page.getByText('Nenhuma sugestão aberta')).toBeVisible();
    await expect(tab(page, 'Sugestões')).toContainText('0');
    await page.getByRole('button', { name: 'Limpar filtros' }).click();
    await expect(page.getByRole('article')).toHaveCount(total);
    await page.getByLabel('De', { exact: true }).fill('2025-01-01');
    await expect(page.getByText('Nenhuma sugestão aberta')).toBeVisible();
  });

  test('aceita uma sugestão não ambígua', async ({ page }) => {
    await loginAs(page, 'analista');
    await page.goto('/conciliacao');
    await expect(tab(page, 'Sugestões').locator('.aba-contagem')).toBeVisible();
    const antes = await contagem(page, 'Sugestões');
    const cartao = page
      .getByRole('article')
      .filter({ hasNotText: 'Ambígua' })
      .filter({ hasNotText: /Divergência|Diferença/ })
      .first();
    await expect(cartao).toBeVisible();
    estado.aceita = (await cartao.locator('.conc-desc').first().innerText()).trim();
    await cartao.getByRole('button', { name: 'Aceitar', exact: true }).click();
    await expect(toast(page)).toContainText('Sugestão aceita.');
    await expect.poll(() => contagem(page, 'Sugestões')).toBe(antes - 1);
    await expect.poll(() => contagem(page, 'Conciliados')).toBeGreaterThan(0);
  });

  test('rejeita uma sugestão informando o motivo', async ({ page }) => {
    await loginAs(page, 'analista');
    await page.goto('/conciliacao');
    await expect(tab(page, 'Sugestões').locator('.aba-contagem')).toBeVisible();
    const antes = await contagem(page, 'Sugestões');
    await page.getByRole('article').first().getByRole('button', { name: 'Rejeitar' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Rejeitar sugestão' });
    await dialogo.getByRole('button', { name: 'Rejeitar' }).click();
    await expect(dialogo.getByText('Informe o motivo.')).toBeVisible();
    await dialogo.getByLabel('Motivo').fill('Documentos não correspondem');
    await dialogo.getByRole('button', { name: 'Rejeitar' }).click();
    await expect(toast(page)).toContainText('Sugestão rejeitada.');
    await expect.poll(() => contagem(page, 'Sugestões')).toBe(antes - 1);
  });

  test('o detalhe mostra a decomposição da confiança', async ({ page }) => {
    await loginAs(page, 'analista');
    await page.goto('/conciliacao');
    await page.getByRole('article').first().getByRole('button', { name: 'Detalhe' }).click();
    const gaveta = page.getByRole('dialog', { name: 'Detalhe da sugestão' });
    await expect(gaveta.getByRole('heading', { name: 'Decomposição da confiança' })).toBeVisible();
    const decomposicao = gaveta.locator('.conc-decomp');
    await expect(decomposicao.getByText('Valor', { exact: true })).toBeVisible();
    await expect(decomposicao.getByText('Data', { exact: true })).toBeVisible();
    await expect(decomposicao.getByRole('img').first()).toBeVisible();
    await expect(gaveta.getByRole('heading', { name: 'Histórico de decisões' })).toBeVisible();
    await expect(gaveta.getByText('Extrato').first()).toBeVisible();
    await gaveta.getByRole('button', { name: 'Fechar' }).click();
    await expect(gaveta).toBeHidden();
  });

  test('concilia manualmente um item pendente do extrato; a decisão vai para aprovação', async ({ page }) => {
    await loginAs(page, 'analista');
    estado.analista = await parPendente(page);
    await proporManual(page, estado.analista);
    await expect(tab(page, 'Pendentes')).toBeVisible();
    // Aguardando aprovação: o item sai das pendências
    await page.goto('/conciliacao?aba=pendentes&situacao=awaiting_approval');
    await expect(page.getByRole('table', { name: 'Itens de Extrato' })).toContainText(estado.analista.extrato.description);
    await expect(page.getByRole('navigation', { name: 'Menu principal' }).getByRole('link', { name: /Aprovações/ })).toHaveCount(0);
  });

  test('o proponente não aprova a própria decisão; outro usuário aprova', async ({ page, problems }) => {
    problems.tolerate({ status: 403, url: /\/reconciliation\/matches\/[^/]+\/approve$/ });
    await loginAs(page, 'gestor');
    estado.gestor = await parPendente(page, [estado.analista!.extrato.id, estado.analista!.lancamento.id]);
    await proporManual(page, estado.gestor);

    await page.getByRole('navigation', { name: 'Menu principal' }).getByRole('link', { name: /Aprovações/ }).click();
    await expect(page.getByRole('heading', { name: 'Aprovações', level: 1 })).toBeVisible();
    const propria = page.getByRole('article', { name: 'Conciliação proposta por Gestor Demonstração' });
    const doAnalista = page.getByRole('article', { name: 'Conciliação proposta por Analista Demonstração' });
    await expect(propria).toContainText(estado.gestor.extrato.description);
    await expect(doAnalista).toContainText(estado.analista!.extrato.description);

    await propria.getByRole('button', { name: 'Aprovar' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Aprovar conciliação' });
    await dialogo.getByRole('button', { name: 'Aprovar' }).click();
    await expect(dialogo.getByRole('alert')).toContainText('Quem propôs a conciliação não pode aprová-la');
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(propria).toBeVisible();

    await doAnalista.getByRole('button', { name: 'Aprovar' }).click();
    await page.getByRole('dialog', { name: 'Aprovar conciliação' }).getByRole('button', { name: 'Aprovar' }).click();
    await expect(toast(page)).toContainText('Conciliação aprovada.');
    await expect(doAnalista).toHaveCount(0);
    await expect(propria).toBeVisible();

    // A aprovada aparece em Conciliados
    await page.goto('/conciliacao?aba=conciliados');
    await expect(page.getByRole('table', { name: 'Itens de Extrato' })).toContainText(estado.analista!.extrato.description);
  });

  test('recusar exige motivo e libera os itens da proposta do gestor', async ({ page }) => {
    await loginAs(page, 'admin');
    // O administrador não propôs nada: pode recusar. Se não puder aprovar, a tela não mostra a fila.
    await page.goto('/aprovacoes');
    const propria = page.getByRole('article', { name: 'Conciliação proposta por Gestor Demonstração' });
    await expect(propria).toBeVisible();
    await propria.getByRole('button', { name: 'Recusar' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Recusar conciliação' });
    await expect(dialogo.getByRole('button', { name: 'Recusar' })).toBeDisabled();
    await dialogo.getByLabel('Motivo da recusa').fill('Valores não conferem');
    await dialogo.getByRole('button', { name: 'Recusar' }).click();
    await expect(toast(page)).toContainText('Conciliação recusada.');
    await expect(propria).toHaveCount(0);
    await expect(page.getByText('Nenhuma aprovação pendente')).toBeVisible();
    await logout(page);
  });
});
