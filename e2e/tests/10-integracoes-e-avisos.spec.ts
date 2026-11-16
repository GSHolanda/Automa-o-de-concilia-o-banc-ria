import type { Page } from '@playwright/test';
import { apiItems, expect, loginAs, logout, test } from '../support/fixtures';

test.describe.configure({ mode: 'serial' });

const toast = (page: Page) => page.getByRole('region', { name: 'Notificações' });

interface Item { id: string; description: string; amountCents: number; openSuggestions: number }

async function habilitar(page: Page, modulo: string): Promise<void> {
  const botao = page.getByRole('button', { name: `Habilitar ${modulo}` });
  if (await botao.count()) {
    await botao.click();
    await expect(page.getByRole('button', { name: `Desabilitar ${modulo}` })).toBeVisible();
  }
}

test.describe('10. Integrações, tokens, notificações e avisos', () => {
  test('as telas abrem sem erro, avisando quando o módulo não está ativo', async ({ page }) => {
    await loginAs(page, 'admin');
    for (const [rota, titulo] of [
      ['/configuracoes/integracoes', 'Integrações'],
      ['/configuracoes/tokens-api', 'Tokens de API'],
      ['/configuracoes/notificacoes', 'Notificações'],
      ['/configuracoes/licenca', 'Licença'],
    ] as const) {
      await page.goto(rota);
      await expect(page.getByRole('heading', { name: titulo, level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByText('Em construção')).toHaveCount(0);
    }
    await page.goto('/configuracoes/tokens-api');
    await expect(page.getByText('O módulo API de lançamentos não está ativo')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir para Módulos' })).toBeVisible();
  });

  test('habilita os módulos usados nas telas', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/configuracoes/modulos');
    await expect(page.getByRole('table', { name: 'Catálogo de módulos' })).toBeVisible();
    for (const nome of ['API de lançamentos', 'Notificações por webhook', 'Sugestões por IA', 'Conector REST']) await habilitar(page, nome);
  });

  test('cria um token de API e vê o valor uma única vez', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/configuracoes/tokens-api');
    await page.getByRole('button', { name: 'Novo token' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Novo token de API' });
    await dialogo.getByLabel('Nome').fill('ERP de testes');
    await dialogo.getByRole('button', { name: 'Criar token' }).click();
    const segredo = page.getByRole('dialog', { name: 'Token de API criado' });
    const token = (await segredo.locator('code').innerText()).trim();
    expect(token.length).toBeGreaterThan(20);
    await segredo.getByRole('button', { name: 'Fechar' }).click();

    const linha = page.getByRole('row').filter({ hasText: 'ERP de testes' });
    await expect(linha).toContainText('Ativo');
    await expect(linha).toContainText('Nunca usado');
    await expect(page.getByText(token)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(token)).toHaveCount(0);
    await expect(page.getByText('Idempotency-Key').first()).toBeVisible();
    await expect(page.locator('pre')).toContainText('/api/v1/integrations/ledger/entries');
  });

  test('webhook inalcançável: o teste termina em erro com mensagem, nunca verificada', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/configuracoes/integracoes');
    await page.getByRole('button', { name: 'Nova integração Webhook' }).click();
    const dialogo = page.getByRole('dialog', { name: /Nova integração: Webhook/ });
    await dialogo.getByLabel('Nome').fill('Webhook inalcançável');
    await dialogo.getByLabel('Endereço do webhook').fill('http://127.0.0.1:9/hook');
    await dialogo.getByLabel('Segredo de assinatura').fill('segredo-de-teste-123');
    await dialogo.getByRole('button', { name: 'Salvar' }).click();
    const cartao = page.getByRole('article', { name: 'Integração Webhook inalcançável' });
    await expect(cartao).toContainText('Configurada');
    await expect(cartao).toContainText('Configurado');
    await expect(page.getByText('segredo-de-teste-123')).toHaveCount(0);

    await cartao.getByRole('button', { name: /Testar conexão/ }).click();
    await expect(cartao).toContainText('Com erro');
    await expect(cartao).toContainText('Último erro');
    await expect(cartao).not.toContainText('Verificada');
  });

  test('cria uma regra de notificação por aviso interno', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/configuracoes/notificacoes');
    await page.getByRole('button', { name: 'Nova regra' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Nova regra de notificação' });
    await dialogo.getByLabel('Evento').selectOption('import.failed');
    await dialogo.getByLabel('Gestor', { exact: false }).first().check();
    await dialogo.getByRole('button', { name: 'Salvar' }).click();
    await expect(toast(page)).toContainText('Regra criada.');
    await expect(page.getByRole('row').filter({ hasText: 'Importação com falha' })).toContainText('Aviso interno');
    await page.getByRole('tab', { name: 'Entregas' }).click();
    await expect(page.getByText('Nenhuma entrega registrada').or(page.getByRole('table', { name: 'Histórico de entregas' }))).toBeVisible();
  });

  test('sugerir por IA sem provedor verificado mostra o link para Integrações', async ({ page, problems }) => {
    problems.tolerate({ status: 409, url: /\/ai\/suggest-categories$/ });
    await loginAs(page, 'analista');
    await page.goto('/conciliacao?aba=pendentes');
    const linha = page.getByRole('table', { name: 'Itens de Extrato' }).getByRole('row').nth(1);
    await linha.getByRole('checkbox', { name: 'Selecionar linha' }).check();
    await page.getByRole('button', { name: 'Sugerir categorias por IA' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Sugerir categorias por IA' });
    await expect(dialogo).toContainText('sugestões a revisar');
    await dialogo.getByRole('button', { name: 'Pedir sugestões' }).click();
    await expect(dialogo.getByRole('alert')).toContainText('Nenhuma integração de IA verificada');
    await expect(dialogo.getByRole('link', { name: 'Abrir Integrações' })).toBeVisible();
  });

  test('o sino mostra o aviso de uma decisão que exige aprovação e permite marcar como lido', async ({ page }) => {
    await loginAs(page, 'analista');
    const bank = await apiItems<Item>(page, '/reconciliation/items?side=bank&status=pending');
    const ledger = await apiItems<Item>(page, '/reconciliation/items?side=ledger&status=pending');
    const livre = (l: Item[]) => l.filter((i) => i.openSuggestions === 0);
    let par: { b: Item; l: Item } | undefined;
    for (const b of livre(bank)) {
      const l = livre(ledger).find((x) => Math.sign(x.amountCents) === Math.sign(b.amountCents));
      if (l) { par = { b, l }; break; }
    }
    expect(par, 'par pendente disponível').toBeDefined();
    const csrf = (await (await page.request.get('/api/v1/auth/me')).json()).csrfToken as string;
    const resp = await page.request.post('/api/v1/reconciliation/matches/manual', {
      headers: { 'X-CSRF-Token': csrf },
      data: { bankTransactionIds: [par!.b.id], ledgerEntryIds: [par!.l.id], note: 'Teste de aviso' },
    });
    expect(resp.status()).toBe(201);
    await logout(page);

    await loginAs(page, 'admin');
    const sino = page.getByRole('button', { name: /^Avisos, \d+ não lidos?$/ });
    await expect(sino).toBeVisible();
    await sino.click();
    const lista = page.getByRole('region', { name: 'Lista de avisos' });
    await expect(lista).toContainText('Conciliação aguardando aprovação');
    await lista.getByRole('button', { name: 'Marcar todos como lidos' }).click();
    await expect(page.getByRole('button', { name: 'Avisos', exact: true })).toBeVisible();
    await expect(lista.getByRole('button', { name: /Marcar como lido/ })).toHaveCount(0);
  });
});
