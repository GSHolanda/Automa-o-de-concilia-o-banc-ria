import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, buildTestApp, createTenant, loggedIn, type TestTenant } from '../helpers/app';
import { closePools } from '../helpers/db';
import { buildXlsx, createBankAccount, uploadImport, type TestBankAccount } from '../helpers/imports';
import { appendZipEntry, deflatedZeros } from '../helpers/zip';

/** Achado 2 da revisão de segurança: XLSX pequeno não pode esgotar a memória do processo. */
let app: FastifyInstance;
let tenant: TestTenant;
let admin: ApiClient;
let account: TestBankAccount;

const MiB = 1024 * 1024;

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'xlsx-limites' });
  admin = await loggedIn(app, tenant.adminEmail);
  account = await createBankAccount(tenant.tenantId, { name: 'Conta Planilha' });
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('limites na leitura de XLSX', () => {
  it('recusa com mensagem clara uma planilha válida com "imagem" de 1 GiB de zeros e continua atendendo', async () => {
    const workbook = await buildXlsx([['Data', 'Descrição', 'Valor'], ['01/03/2024', 'DEPOSITO', 10]], 'Extrato');
    const zeros = await deflatedZeros(1024 * MiB);
    const content = appendZipEntry(workbook, 'xl/media/image1.png', zeros, 1024 * MiB);
    expect(content.length).toBeLessThan(2 * MiB);

    const before = process.memoryUsage().rss;
    const upload = await uploadImport(admin, { sourceKind: 'bank', bankAccountId: account.id, fileName: 'extrato.xlsx', content });
    expect(upload.status).toBe(400);
    expect(upload.body.error.message).toMatch(/descompactad/);
    expect(process.memoryUsage().rss - before).toBeLessThan(300 * MiB);

    // O processo segue de pé e lê planilhas normais.
    expect((await admin.get('/healthz')).status).toBe(200);
    const normal = await uploadImport(admin, { sourceKind: 'bank', bankAccountId: account.id, fileName: 'ok.xlsx', content: workbook });
    expect(normal.status).toBe(201);
  });

  it('recusa planilha com colunas demais antes de montar as linhas', async () => {
    const row = Array.from({ length: 600 }, (_, index) => `C${index + 1}`);
    const content = await buildXlsx([row, row], 'Larga');
    const upload = await uploadImport(admin, { sourceKind: 'bank', bankAccountId: account.id, fileName: 'larga.xlsx', content });
    expect(upload.status).toBe(400);
    expect(upload.body.error.message).toMatch(/limite de 512 colunas/);
  });
});
