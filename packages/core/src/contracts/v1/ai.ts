import { z } from 'zod';

/**
 * Dados enviados ao provedor de IA: só descrição normalizada, sinal e tipo.
 * As referências (`t1`, `c1`) são locais à chamada; nenhum identificador interno sai do sistema.
 */
export interface AiTransactionInputV1 {
  ref: string;
  descriptionNorm: string;
  direction: 'in' | 'out';
  kind: string;
}

export interface AiCategoryInputV1 {
  ref: string;
  name: string;
}

export const aiCategorySuggestionV1Schema = z
  .object({
    transactionRef: z.string().min(1).max(20),
    /** Nulo: o provedor não tem sugestão para a transação. */
    categoryRef: z.string().min(1).max(20).nullable(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().max(500),
  })
  .strict();

export const aiCategorySuggestionsV1Schema = z
  .object({ suggestions: z.array(aiCategorySuggestionV1Schema).max(500) })
  .strict();

export type AiCategorySuggestionV1 = z.infer<typeof aiCategorySuggestionV1Schema>;

/** JSON Schema equivalente, para pedir saída estruturada ao provedor. */
export const AI_CATEGORY_SUGGESTIONS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['transactionRef', 'categoryRef', 'confidence', 'rationale'],
        properties: {
          transactionRef: { type: 'string' },
          categoryRef: { type: ['string', 'null'] },
          confidence: { type: 'number' },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Provedor de sugestões por IA (contrato v1). Produz apenas sugestões, sujeitas a aceite humano. */
export interface AiAssistProviderV1 {
  readonly version: 'v1';
  /** Chamada real mínima de verificação. */
  test(): Promise<void>;
  /** Lança erro se a resposta não estiver no formato: nunca devolve sugestão inventada. */
  suggestCategories(input: {
    transactions: AiTransactionInputV1[];
    categories: AiCategoryInputV1[];
  }): Promise<AiCategorySuggestionV1[]>;
}
