import { describe, expect, it } from 'vitest';
import {
  aiCategorySuggestionsV1Schema,
  INTEGRATION_MODULES,
  integrationConfigSchemas,
  ledgerEntryInputV1Schema,
  mapConnectorItem,
  NOTIFICATION_EVENTS,
  readPath,
} from '../src/contracts/v1';

describe('ledgerEntryInputV1Schema', () => {
  it('aceita lançamento mínimo em centavos e data civil', () => {
    const parsed = ledgerEntryInputV1Schema.parse({ date: '2024-05-10', amountCents: -32000, description: 'Fornecedor' });
    expect(parsed).toMatchObject({ date: '2024-05-10', amountCents: -32000, description: 'Fornecedor' });
  });

  it('recusa valor zero, valor fracionário e data inexistente', () => {
    expect(ledgerEntryInputV1Schema.safeParse({ date: '2024-05-10', amountCents: 0, description: 'x' }).success).toBe(false);
    expect(ledgerEntryInputV1Schema.safeParse({ date: '2024-05-10', amountCents: 10.5, description: 'x' }).success).toBe(false);
    expect(ledgerEntryInputV1Schema.safeParse({ date: '2024-02-30', amountCents: 100, description: 'x' }).success).toBe(false);
    expect(ledgerEntryInputV1Schema.safeParse({ date: '10/05/2024', amountCents: 100, description: 'x' }).success).toBe(false);
  });
});

describe('mapConnectorItem', () => {
  const fieldMap = { date: 'data', amount: 'valor.total', description: 'historico', externalId: 'id' };

  it('lê caminhos com ponto e converte valor decimal em centavos', () => {
    const entry = mapConnectorItem({ id: 77, data: '2024-05-10T00:00:00Z', valor: { total: '-320.15' }, historico: 'Pagamento' }, fieldMap);
    expect(entry).toMatchObject({ externalId: '77', date: '2024-05-10', amountCents: -32015, description: 'Pagamento' });
    expect(ledgerEntryInputV1Schema.safeParse(entry).success).toBe(true);
  });

  it('aceita valor já em centavos quando configurado', () => {
    const entry = mapConnectorItem({ data: '10/05/2024', valor: { total: 1500 }, historico: 'Recebimento' }, fieldMap, {
      amountUnit: 'cents',
    });
    expect(entry).toMatchObject({ date: '2024-05-10', amountCents: 1500 });
  });

  it('campo ilegível fica ausente e a validação do lançamento aponta o problema', () => {
    const entry = mapConnectorItem({ data: 'ontem', valor: { total: 'abc' }, historico: '' }, fieldMap);
    const result = ledgerEntryInputV1Schema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('readPath devolve indefinido para caminho inexistente', () => {
    expect(readPath({ a: { b: [1, 2] } }, 'a.b.1')).toBe(2);
    expect(readPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
  });
});

describe('configurações de integração', () => {
  it('cada tipo exige o módulo correspondente', () => {
    expect(INTEGRATION_MODULES).toEqual({
      webhook: 'notifications.webhook',
      smtp: 'notifications.email',
      rest_ledger: 'connector.rest',
      ai_provider: 'ai.assist',
    });
  });

  it('webhook exige URL http(s); IA usa modelo padrão', () => {
    expect(integrationConfigSchemas.webhook.safeParse({ url: 'ftp://exemplo.test' }).success).toBe(false);
    expect(integrationConfigSchemas.webhook.parse({ url: 'https://exemplo.test/gancho' })).toEqual({
      url: 'https://exemplo.test/gancho',
    });
    expect(integrationConfigSchemas.ai_provider.parse({ provider: 'anthropic' })).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
    });
  });

  it('conector REST exige mapa de campos com data, valor e descrição', () => {
    const base = { baseUrl: 'https://erp.exemplo.test', path: '/lancamentos', authType: 'bearer' };
    expect(integrationConfigSchemas.rest_ledger.safeParse({ ...base, fieldMap: { date: 'd' } }).success).toBe(false);
    const parsed = integrationConfigSchemas.rest_ledger.parse({
      ...base,
      fieldMap: { date: 'd', amount: 'v', description: 'h' },
    });
    expect(parsed).toMatchObject({ itemsPath: null, amountUnit: 'decimal' });
    // Cabeçalho personalizado exige o nome do cabeçalho.
    expect(
      integrationConfigSchemas.rest_ledger.safeParse({ ...base, authType: 'header', fieldMap: { date: 'd', amount: 'v', description: 'h' } })
        .success,
    ).toBe(false);
  });
});

describe('sugestões de IA', () => {
  it('formato válido passa; campos a mais, confiança fora do intervalo ou referência vazia são recusados', () => {
    const ok = { suggestions: [{ transactionRef: 't1', categoryRef: 'c2', confidence: 0.8, rationale: 'Tarifa' }] };
    expect(aiCategorySuggestionsV1Schema.safeParse(ok).success).toBe(true);
    expect(
      aiCategorySuggestionsV1Schema.safeParse({ suggestions: [{ ...ok.suggestions[0], confidence: 1.5 }] }).success,
    ).toBe(false);
    expect(aiCategorySuggestionsV1Schema.safeParse({ suggestions: [{ ...ok.suggestions[0], extra: 1 }] }).success).toBe(
      false,
    );
    expect(aiCategorySuggestionsV1Schema.safeParse({ itens: [] }).success).toBe(false);
  });

  it('eventos de notificação conhecidos', () => {
    expect(NOTIFICATION_EVENTS).toEqual([
      'import.completed',
      'import.failed',
      'reconciliation.completed',
      'approval.requested',
      'job.dead',
    ]);
  });
});
