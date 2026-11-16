import { expect, login, logout, test } from '../support/fixtures';
import { PLATFORM_EMAIL, PLATFORM_PASSWORD } from '../global-setup';

const NOVA_SENHA = 'Outra-Senha-Segura-2024';
const ADMIN_EMAIL = 'responsavel@nova-empresa.exemplo.test';

test.describe('8. Operador da plataforma e implantação', () => {
  test('o operador cria uma empresa e o administrador dela conclui a implantação', async ({ page, problems }) => {
    problems.tolerate({ status: 422, url: /\/onboarding\/complete$/ });
    problems.tolerate({ status: 409, url: /\/onboarding\/complete$/ });
    problems.tolerate({ status: 400, url: /\/onboarding\/complete$/ });

    // Operador da plataforma
    await login(page, PLATFORM_EMAIL, PLATFORM_PASSWORD);
    const menu = page.getByRole('navigation', { name: 'Menu principal' });
    await expect(menu.getByRole('link', { name: 'Empresas' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Conciliação' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Empresas', level: 1 })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Empresas' }).getByRole('row').filter({ hasText: 'Comércio Exemplo Ltda' })).toBeVisible();

    await page.getByRole('button', { name: 'Nova empresa' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Nova empresa' });
    await dialogo.getByLabel('Identificador').fill('nova-empresa');
    await dialogo.getByLabel('Razão social').fill('Nova Empresa Fictícia Ltda');
    await dialogo.getByLabel('Nome fantasia').fill('Nova Empresa');
    await dialogo.getByLabel('Plano').selectOption({ index: 1 });
    await dialogo.getByLabel('Nome do administrador').fill('Responsável Nova Empresa');
    await dialogo.getByLabel('E-mail do administrador').fill(ADMIN_EMAIL);
    await dialogo.getByRole('button', { name: 'Salvar' }).click();

    const segredo = page.getByRole('dialog', { name: 'Administrador de Nova Empresa' });
    await expect(segredo).toBeVisible();
    const senhaTemporaria = (await segredo.locator('code').innerText()).trim();
    expect(senhaTemporaria.length).toBeGreaterThanOrEqual(12);
    await segredo.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.getByRole('table', { name: 'Empresas' }).getByRole('row').filter({ hasText: 'Nova Empresa' }).filter({ hasText: 'Implantação' })).toBeVisible();
    await logout(page);

    // O administrador da nova empresa é obrigado a trocar a senha
    await login(page, ADMIN_EMAIL, senhaTemporaria);
    await expect(page).toHaveURL(/\/trocar-senha/);
    await expect(page.getByText('Sua senha é temporária')).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL(/\/trocar-senha/);

    await page.getByLabel('Senha atual').fill(senhaTemporaria);
    await page.getByLabel(/^Nova senha/).fill(NOVA_SENHA);
    await page.getByLabel('Confirmar nova senha').fill(NOVA_SENHA);
    await page.getByRole('button', { name: 'Trocar senha' }).click();
    await expect(menu).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('A implantação da empresa ainda não foi concluída.')).toBeVisible();

    // Assistente de implantação
    await page.getByRole('link', { name: 'Continuar a implantação' }).click();
    await expect(page.getByRole('heading', { name: 'Implantação', level: 1 })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Progresso da implantação' })).toBeVisible();
    await page.getByRole('button', { name: 'Concluir implantação' }).click();
    const faltas = page.getByRole('alert').filter({ hasText: 'Ainda falta concluir' });
    await expect(faltas).toContainText('Contas bancárias');

    // Etapa: contas bancárias
    await page.getByRole('link', { name: 'Abrir contas bancárias' }).click();
    await page.getByRole('button', { name: 'Nova conta bancária' }).first().click();
    const conta = page.getByRole('dialog', { name: 'Nova conta bancária' });
    await conta.getByLabel('Nome').fill('Conta Principal');
    await conta.getByLabel('Código do banco').fill('999');
    await conta.getByLabel('Agência').fill('0001');
    await conta.getByLabel('Número da conta').fill('12345-6');
    await conta.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByRole('region', { name: 'Notificações' })).toContainText('Conta bancária criada.');

    // Etapa: dados da empresa
    await page.goto('/configuracoes/empresa');
    await page.getByLabel('CNPJ').fill('11.222.333/0001-81');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByRole('region', { name: 'Notificações' })).toContainText('Dados da empresa salvos.');

    await page.goto('/implantacao');
    const etapa = (titulo: string) => page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: new RegExp(titulo) }) });
    for (const titulo of ['Dados da empresa', 'Contas bancárias']) {
      const item = etapa(titulo);
      await expect(item).toBeVisible();
      if (await item.getByText('Pendente', { exact: true }).isVisible()) {
        await item.getByRole('button', { name: /Marcar como concluída/ }).click();
      }
      await expect(item.getByText('Concluída', { exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Concluir implantação' }).click();
    await expect(page.getByRole('region', { name: 'Notificações' })).toContainText('Implantação concluída. A empresa está ativa.');
    await expect(page.getByText('A implantação já foi concluída e a empresa está ativa.')).toBeVisible();
    await expect(page.getByText('A implantação da empresa ainda não foi concluída.')).toHaveCount(0);
  });
});
