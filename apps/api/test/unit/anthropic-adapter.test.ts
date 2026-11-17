import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiProviderError, createAnthropicProvider } from '../../src/integrations/anthropic';
import { fakeMessage, json, startLocalTestServer, type LocalTestServer } from '../helpers/fake-servers';

// Adaptador de IA contra servidor HTTP local de teste que imita a API de mensagens.
// Não há chave real neste ambiente: o serviço real NÃO é chamado nem verificado aqui.
const API_KEY = 'chave-ficticia-de-teste-local';
let server: LocalTestServer;

const input = {
  transactions: [
    { ref: 't1', descriptionNorm: 'TARIFA PACOTE SERVICOS', direction: 'out' as const, kind: 'fee' },
    { ref: 't2', descriptionNorm: 'PIX RECEBIDO CLIENTE', direction: 'in' as const, kind: 'regular' },
  ],
  categories: [
    { ref: 'c1', name: 'Tarifas bancárias' },
    { ref: 'c2', name: 'Receitas de vendas' },
  ],
};

function provider() {
  return createAnthropicProvider(
    { provider: 'anthropic', model: 'claude-haiku-5-5', baseURL: server.url },
    API_KEY,
    { allowPrivate: true },
  );
}

beforeAll(async () => {
  server = await startLocalTestServer();
});
afterAll(() => server.close());

describe('adaptador Anthropic contra servidor HTTP local de teste', () => {
  it('pede saída estruturada, envia só descrição, sentido e tipo, e valida a resposta', async () => {
    const answer = {
      suggestions: [
        { transactionRef: 't1', categoryRef: 'c1', confidence: 0.92, rationale: 'Tarifa bancária' },
        { transactionRef: 't2', categoryRef: null, confidence: 0.2, rationale: 'Sem categoria adequada' },
      ],
    };
    server.respond((_request, res) => json(res, 200, fakeMessage(JSON.stringify(answer))));
    const result = await provider().suggestCategories(input);
    expect(result).toEqual(answer.suggestions);

    const request = server.requests.at(-1)!;
    expect(request.url).toBe('/v1/messages');
    // O SDK 1.x envia a chave como Bearer.
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(request.body);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.output_config.format.type).toBe('json_schema');
    const sent = JSON.parse(body.messages[0].content);
    expect(Object.keys(sent.transactions[0]).sort()).toEqual(['descriptionNorm', 'direction', 'kind', 'ref']);
  });

  it('texto que não é JSON vira erro, nunca sugestão', async () => {
    server.respond((_request, res) => json(res, 200, fakeMessage('Acho que é tarifa.')));
    await expect(provider().suggestCategories(input)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('JSON fora do formato, categoria inexistente ou transação desconhecida viram erro', async () => {
    for (const answer of [
      { itens: [] },
      { suggestions: [{ transactionRef: 't1', categoryRef: 'c9', confidence: 0.9, rationale: 'x' }] },
      { suggestions: [{ transactionRef: 't7', categoryRef: 'c1', confidence: 0.9, rationale: 'x' }] },
      { suggestions: [{ transactionRef: 't1', categoryRef: 'c1', confidence: 2, rationale: 'x' }] },
    ]) {
      server.respond((_request, res) => json(res, 200, fakeMessage(JSON.stringify(answer))));
      await expect(provider().suggestCategories(input), JSON.stringify(answer)).rejects.toBeInstanceOf(AiProviderError);
    }
  });

  it('resposta interrompida (max_tokens) vira erro', async () => {
    server.respond((_request, res) => json(res, 200, fakeMessage('{"suggestions":[', 'max_tokens')));
    await expect(provider().suggestCategories(input)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('chave recusada e servidor inalcançável viram erro sem expor a chave', async () => {
    server.respond((_request, res) =>
      json(res, 401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${API_KEY}` } }),
    );
    const refused = await provider().test().catch((error: unknown) => error as AiProviderError);
    expect(refused).toBeInstanceOf(AiProviderError);
    expect(refused!.message).not.toContain(API_KEY);

    const unreachable = createAnthropicProvider(
      { provider: 'anthropic', model: 'claude-haiku-5-5', baseURL: 'http://127.0.0.1:1' },
      API_KEY,
      { allowPrivate: true },
    );
    await expect(unreachable.test()).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('endereço privado sem liberação é recusado pelo safeFetch', async () => {
    const blocked = createAnthropicProvider(
      { provider: 'anthropic', model: 'claude-haiku-5-5', baseURL: server.url },
      API_KEY,
      { allowPrivate: false },
    );
    const before = server.requests.length;
    await expect(blocked.test()).rejects.toMatchObject({ kind: 'unreachable' });
    expect(server.requests.length).toBe(before);
  });
});
