import Anthropic from '@anthropic-ai/sdk';
import {
  AI_CATEGORY_SUGGESTIONS_JSON_SCHEMA,
  aiCategorySuggestionsV1Schema,
  type AiAssistProviderV1,
  type AiCategorySuggestionV1,
  type AiProviderConfig,
} from '@concilia/core';
import { scrubSecret } from '../security/secrets';
import { safeFetch, SafeFetchError } from './http';

/** Falha do provedor ou resposta fora do formato: nunca vira sugestão. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'rejected' | 'invalid_response',
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

const TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT =
  'Você classifica transações de extrato bancário de uma empresa brasileira em categorias contábeis. ' +
  'Recebe as categorias disponíveis (ref e nome) e as transações (ref, descrição normalizada, sentido in/out e tipo). ' +
  'Para cada transação, escolha a categoria mais provável usando apenas as refs fornecidas, ou null se nenhuma ' +
  'servir. Informe a confiança entre 0 e 1 e uma justificativa curta em português. Responda só no formato pedido.';

function errorMessage(error: unknown, apiKey: string): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiProviderError('Sem resposta do provedor de IA no tempo limite.', 'unreachable');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    const cause = (error as { cause?: unknown }).cause;
    const detail = cause instanceof SafeFetchError ? cause.message : 'Falha de conexão com o provedor de IA.';
    return new AiProviderError(scrubSecret(detail, apiKey), 'unreachable');
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new AiProviderError('O provedor de IA recusou a chave de API (HTTP 401).', 'rejected');
  }
  if (error instanceof Anthropic.APIError) {
    return new AiProviderError(`O provedor de IA respondeu HTTP ${error.status ?? 'desconhecido'}.`, 'rejected');
  }
  return new AiProviderError('Falha ao chamar o provedor de IA.', 'unreachable');
}

/** Adaptador Anthropic do contrato AiAssistProviderV1. Toda chamada passa pelo safeFetch. */
export function createAnthropicProvider(
  config: AiProviderConfig,
  apiKey: string,
  options: { allowPrivate: boolean },
): AiAssistProviderV1 {
  const client = new Anthropic({
    apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    maxRetries: 1,
    timeout: TIMEOUT_MS,
    fetch: (input, init) =>
      safeFetch(input instanceof Request ? input.url : input, init, {
        allowPrivate: options.allowPrivate,
        timeoutMs: TIMEOUT_MS,
      }),
  });

  return {
    version: 'v1',
    async test() {
      try {
        await client.messages.create({
          model: config.model,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Responda apenas: ok' }],
        });
      } catch (error) {
        throw errorMessage(error, apiKey);
      }
    },

    async suggestCategories(input): Promise<AiCategorySuggestionV1[]> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: config.model,
          max_tokens: 8_000,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: JSON.stringify({ categories: input.categories, transactions: input.transactions }),
            },
          ],
          output_config: { format: { type: 'json_schema', schema: AI_CATEGORY_SUGGESTIONS_JSON_SCHEMA } },
        });
      } catch (error) {
        throw errorMessage(error, apiKey);
      }
      if (message.stop_reason !== 'end_turn') {
        throw new AiProviderError(
          `O provedor de IA não concluiu a resposta (${message.stop_reason ?? 'sem motivo'}).`,
          'invalid_response',
        );
      }
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new AiProviderError('A resposta do provedor de IA não é JSON válido.', 'invalid_response');
      }
      const result = aiCategorySuggestionsV1Schema.safeParse(parsed);
      if (!result.success) {
        throw new AiProviderError('A resposta do provedor de IA está fora do formato esperado.', 'invalid_response');
      }
      // Referência desconhecida ou repetida: a resposta inteira é descartada, nada é inventado.
      const transactionRefs = new Set(input.transactions.map((item) => item.ref));
      const categoryRefs = new Set(input.categories.map((item) => item.ref));
      const seen = new Set<string>();
      for (const suggestion of result.data.suggestions) {
        if (!transactionRefs.has(suggestion.transactionRef) || seen.has(suggestion.transactionRef)) {
          throw new AiProviderError('A resposta do provedor de IA cita transação desconhecida ou repetida.', 'invalid_response');
        }
        if (suggestion.categoryRef !== null && !categoryRefs.has(suggestion.categoryRef)) {
          throw new AiProviderError('A resposta do provedor de IA cita categoria inexistente.', 'invalid_response');
        }
        seen.add(suggestion.transactionRef);
      }
      return result.data.suggestions;
    },
  };
}
