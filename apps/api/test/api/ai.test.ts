import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, createTenant, loggedIn, userWithRole, type ApiClient, type TestTenant } from '../helpers/app';
import { closePools, ownerPool } from '../helpers/db';
import { fakeMessage, json, startLocalTestServer, type LocalTestServer, type RecordedRequest } from '../helpers/fake-servers';
import { createBankAccount } from '../helpers/imports';
import { importStatement } from '../helpers/reconciliation';

// Sugestões por IA contra servidor HTTP local de teste que imita a API de mensagens.
// Não há chave real: o provedor real NÃO é chamado nem dado como verificado nestes testes.
const API_KEY = 'chave-ia-ficticia-local-77';

let app: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;
let admin: ApiClient;
let otherAdmin: ApiClient;
let ai: LocalTestServer;
let integrationId: string;
let transactions: any[];

/** Responde como o modelo: TARIFA → categoria "Tarifas bancárias"; o resto sem sugestão. */
function answerByName(request: RecordedRequest) {
  const body = JSON.parse(request.body);
  const input = JSON.parse(body.messages[0].content);
  const fee = input.categories.find((item: { name: string }) => item.name === 'Tarifas bancárias');
  return {
    suggestions: input.transactions.map((item: { ref: string; descriptionNorm: string }) =>
      item.descriptionNorm.includes('TARIFA')
        ? { transactionRef: item.ref, categoryRef: fee.ref, confidence: 0.91, rationale: 'Descrição indica tarifa bancária.' }
        : { transactionRef: item.ref, categoryRef: null, confidence: 0.1, rationale: 'Sem categoria adequada.' },
    ),
  };
}

beforeAll(async () => {
  app = await buildTestApp();
  tenant = await createTenant({ label: 'ia' });
  other = await createTenant({ label: 'ia-outra' });
  admin = await loggedIn(app, tenant.adminEmail);
  otherAdmin = await loggedIn(app, other.adminEmail);
  ai = await startLocalTestServer((request, res) => json(res, 200, fakeMessage(JSON.stringify(answerByName(request)))));
  const account = await createBankAccount(tenant.tenantId, { name: 'Conta IA', accountNumber: '777-1' });
  transactions = await importStatement(app, admin, account, [
    { date: '2024-05-10', amount: '-35,90', memo: 'TARIFA PACOTE SERVICOS' },
    { date: '2024-05-11', amount: '1200,00', memo: 'PIX RECEBIDO CLIENTE FICTICIO' },
  ]);
});

afterAll(async () => {
  await ai.close();
  await app.close();
  await closePools();
});

describe('sugestão de categorias por IA', () => {
  it('módulo ai.assist desabilitado bloqueia a rota', async () => {
    const blocked = await admin.post('/ai/suggest-categories', { bankTransactionIds: [transactions[0].id] });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('module_disabled');
    expect((await admin.put('/modules/ai.assist', { enabled: true })).status).toBe(200);
  });

  it('sem integração verificada responde 409 integration_not_configured', async () => {
    expect((await admin.post('/ai/suggest-categories', { bankTransactionIds: [transactions[0].id] })).body.error.code).toBe(
      'integration_not_configured',
    );
    const created = await admin.post('/integrations', {
      kind: 'ai_provider',
      name: 'IA local de teste',
      config: { provider: 'anthropic', baseURL: ai.url },
      secret: API_KEY,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'configured', config: { model: 'claude-haiku-5-5' } });
    integrationId = created.body.id;
    // Cadastrada, mas sem chamada real bem-sucedida: ainda não serve.
    const refused = await admin.post('/ai/suggest-categories', { bankTransactionIds: [transactions[0].id] });
    expect(refused.status).toBe(409);
  });

  it('teste contra o servidor local de teste → verified (não é verificação do serviço real)', async () => {
    ai.respond((_request, res) => json(res, 200, fakeMessage('ok')));
    const tested = await admin.post(`/integrations/${integrationId}/test`);
    expect(tested.body).toMatchObject({ status: 'verified' });
    ai.respond((request, res) => json(res, 200, fakeMessage(JSON.stringify(answerByName(request)))));
  });

  it('grava sugestão identificada como IA, nunca confirma, e envia só descrição, sentido e tipo', async () => {
    const response = await admin.post('/ai/suggest-categories', {
      bankTransactionIds: [transactions[0].id, transactions[1].id, '00000000-0000-4000-8000-000000000000'],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [fee, income, missing] = response.body.items;
    expect(fee).toMatchObject({ bankTransactionId: transactions[0].id, status: 'suggested', confidence: 0.91 });
    expect(income).toMatchObject({ status: 'no_suggestion' });
    expect(missing).toMatchObject({ status: 'skipped' });

    const match = await ownerPool().query('SELECT * FROM matches WHERE id = $1', [fee.matchId]);
    expect(match.rows[0]).toMatchObject({ origin: 'ai', status: 'suggested', match_type: 'classification', category_id: fee.categoryId });
    const tx = await ownerPool().query('SELECT recon_status, category_id FROM bank_transactions WHERE id = $1', [transactions[0].id]);
    expect(tx.rows[0]).toMatchObject({ recon_status: 'pending' });

    const sent = ai.requests.at(-1)!;
    expect(sent.body).not.toContain(transactions[0].id);
    expect(sent.body).not.toContain('3590');
    expect(sent.body).not.toContain(tenant.tenantId);
    const input = JSON.parse(JSON.parse(sent.body).messages[0].content);
    expect(input.transactions).toEqual([
      { ref: 't1', descriptionNorm: transactions[0].description_norm, direction: 'out', kind: transactions[0].kind },
      { ref: 't2', descriptionNorm: transactions[1].description_norm, direction: 'in', kind: transactions[1].kind },
    ]);

    // A decisão é humana: aceitar confirma a classificação.
    const view = await admin.get(`/reconciliation/matches/${fee.matchId}`);
    expect(view.body).toMatchObject({ origin: 'ai', status: 'suggested' });
    const accepted = await admin.post(`/reconciliation/matches/${fee.matchId}/accept`, {});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.status).toBe('confirmed');

    const audit = await admin.get(`/audit?action=ai.categories_suggested`);
    expect(audit.body.items).toHaveLength(1);
    expect(JSON.stringify(audit.body)).not.toContain(API_KEY);
  });

  it('transação já conciliada é ignorada; resposta fora do formato vira 502 e nada é gravado', async () => {
    const again = await admin.post('/ai/suggest-categories', { bankTransactionIds: [transactions[0].id] });
    expect(again.body.items[0]).toMatchObject({ status: 'skipped' });

    ai.respond((_request, res) => json(res, 200, fakeMessage('{"suggestions":[{"transactionRef":"t1","categoryRef":"c999","confidence":0.9,"rationale":"x"}]}')));
    const before = await ownerPool().query(`SELECT count(*)::int AS total FROM matches WHERE tenant_id = $1 AND origin = 'ai'`, [tenant.tenantId]);
    const invalid = await admin.post('/ai/suggest-categories', { bankTransactionIds: [transactions[1].id] });
    expect(invalid.status).toBe(502);
    expect(invalid.body.error.code).toBe('ai_invalid_response');
    const after = await ownerPool().query(`SELECT count(*)::int AS total FROM matches WHERE tenant_id = $1 AND origin = 'ai'`, [tenant.tenantId]);
    expect(after.rows[0].total).toBe(before.rows[0].total);
    // Resposta malformada não derruba a verificação; falha do provedor sim.
    expect((await admin.get(`/integrations/${integrationId}`)).body.status).toBe('verified');
  });

  it('CA-27: provedor inalcançável ou com erro → 502 e a integração passa a error', async () => {
    ai.respond((_request, res) => json(res, 500, { type: 'error', error: { type: 'api_error', message: `falha ${API_KEY}` } }));
    const failed = await admin.post('/ai/suggest-categories', { bankTransactionIds: [transactions[1].id] });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('ai_provider_error');
    expect(JSON.stringify(failed.body)).not.toContain(API_KEY);
    const integration = await admin.get(`/integrations/${integrationId}`);
    expect(integration.body.status).toBe('error');
    expect(integration.body.lastError).not.toContain(API_KEY);
    expect((await admin.post('/ai/suggest-categories', { bankTransactionIds: [transactions[1].id] })).status).toBe(409);
  });

  it('isolamento e permissão: outra empresa não usa a integração nem vê as transações', async () => {
    expect((await otherAdmin.put('/modules/ai.assist', { enabled: true })).status).toBe(200);
    const refused = await otherAdmin.post('/ai/suggest-categories', { bankTransactionIds: [transactions[1].id] });
    expect(refused.status).toBe(409);
    const viewer = await userWithRole(app, admin, 'auditor');
    expect((await viewer.post('/ai/suggest-categories', { bankTransactionIds: [transactions[1].id] })).status).toBe(403);
  });
});
