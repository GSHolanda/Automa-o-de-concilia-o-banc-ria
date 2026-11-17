import { fileURLToPath } from 'node:url';
import { expect, test as base, type Page } from '@playwright/test';
import { DEMO_PASSWORD } from '../global-setup';

export { DEMO_PASSWORD, expect };

export type Persona = 'admin' | 'gestor' | 'analista' | 'auditor';
export const demoEmail = (persona: Persona) => `${persona}@demo.exemplo.test`;

interface Problem {
  kind: string;
  text: string;
}

/** Respostas 4xx esperadas pelo teste (o navegador também as registra no console). */
export interface Tolerated {
  status: number;
  url: RegExp;
}

export const test = base.extend<{ problems: { tolerate: (item: Tolerated) => void } }>({
  // A porta da API é sorteada no globalSetup, depois de lida a configuração.
  baseURL: async ({}, use) => {
    await use(process.env.E2E_BASE_URL);
  },
  // Todo teste falha se o console tiver erro, se a página lançar exceção ou se a API responder 5xx
  // (ou 4xx que o teste não declarou como esperado).
  problems: [
    async ({ page }, use) => {
      const found: Problem[] = [];
      const tolerated: Tolerated[] = [{ status: 401, url: /\/api\/v1\/auth\/me$/ }];
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        // "Failed to load resource" é o eco de uma resposta HTTP, já tratada abaixo.
        if (/Failed to load resource/.test(message.text())) return;
        found.push({ kind: 'console', text: message.text() });
      });
      page.on('pageerror', (error) => found.push({ kind: 'exceção', text: error.message }));
      page.on('response', (response) => {
        const status = response.status();
        const url = response.url();
        if (status < 400 || !url.includes('/api/')) return;
        if (status < 500 && tolerated.some((item) => item.status === status && item.url.test(url))) return;
        found.push({ kind: `HTTP ${status}`, text: `${response.request().method()} ${url}` });
      });
      await use({ tolerate: (item) => tolerated.push(item) });
      expect(found, 'erros de console, exceções ou respostas de erro da API').toEqual([]);
    },
    { auto: true },
  ],
});

/** Entra pela tela de login e espera o menu principal. */
export async function login(page: Page, email: string, password = DEMO_PASSWORD): Promise<void> {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

export async function loginAs(page: Page, persona: Persona): Promise<void> {
  await login(page, demoEmail(persona));
  await expect(page.getByRole('navigation', { name: 'Menu principal' })).toBeVisible();
}

/**
 * Sai pela própria interface, como um usuário: o aplicativo cancela as consultas em andamento antes de encerrar a
 * sessão. Apagar só o cookie deixaria consultas periódicas chegando ao servidor sem sessão (401 legítimo).
 */
export async function logout(page: Page): Promise<void> {
  // Espera a página assentar: sair com consultas ainda a caminho (ex.: logo após um page.goto) faria o servidor
  // receber requisições sem sessão, o que é legítimo, mas não é o que o teste quer medir.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const userButton = page.locator('button.usuario-botao');
  if (await userButton.isVisible().catch(() => false)) {
    await userButton.click();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/v1/auth/logout')),
      page.getByRole('menuitem', { name: 'Sair' }).click(),
    ]);
  }
  await page.context().clearCookies();
  await page.goto('/entrar');
}

/** Falha se a página tiver rolagem horizontal. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll, `rolagem horizontal (${widths.scroll} > ${widths.client})`).toBeLessThanOrEqual(widths.client);
}

/**
 * Troca a fonte da página por uma mais larga, como as que o sistema operacional usa quando falta a preferida.
 * Os runners de CI não têm as mesmas fontes do ambiente de desenvolvimento; o layout não pode depender delas.
 * Usa folha de estilo adotada, permitida pela política de segurança de conteúdo (que bloqueia estilo inline).
 */
export async function useWideFont(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('* { font-family: "DejaVu Sans", Verdana, sans-serif !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
}

/** Grava uma captura de tela em docs/capturas/. */
export async function captura(page: Page, nome: string): Promise<void> {
  const caminho = fileURLToPath(new URL(`../../docs/capturas/${nome}.png`, import.meta.url));
  await page.screenshot({ path: caminho });
}

/** Itens da API (todas as páginas até 200) vistos pela sessão do navegador. */
export async function apiItems<T>(page: Page, path: string): Promise<T[]> {
  const response = await page.request.get(`/api/v1${path}${path.includes('?') ? '&' : '?'}limit=200`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: T[] }).items;
}
