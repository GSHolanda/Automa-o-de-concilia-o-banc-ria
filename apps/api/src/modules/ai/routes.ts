import {
  aiProviderConfigSchema,
  pairKey,
  type AiCategoryInputV1,
  type AiCategorySuggestionV1,
  type AiTransactionInputV1,
} from '@concilia/core';
import { z } from 'zod';
import type { Db } from '../../db/context';
import { AppError, conflict } from '../../http/errors';
import { route, type RouteDefinition } from '../../http/route';
import { AiProviderError, createAnthropicProvider } from '../../integrations/anthropic';
import { scrubSecret } from '../../security/secrets';
import { ERROR_LIMIT, readSecret, recordCheck, type IntegrationRow } from '../integrations/store';

const MAX_TRANSACTIONS = 100;

interface TransactionRow {
  id: string;
  bank_account_id: string;
  description_norm: string;
  amount_cents: string;
  kind: string;
  recon_status: string;
  reserved: boolean;
}

type ResultItem =
  | { bankTransactionId: string; status: 'suggested'; matchId: string; categoryId: string; confidence: number; rationale: string }
  | { bankTransactionId: string; status: 'no_suggestion'; rationale: string }
  | { bankTransactionId: string; status: 'skipped'; reason: string };

/** Transações pendentes e sem conciliação ativa; as demais saem como ignoradas. */
async function eligibleTransactions(
  db: Db,
  tenantId: string,
  ids: string[],
): Promise<{ eligible: TransactionRow[]; results: Map<string, ResultItem> }> {
  const found = await db.query<TransactionRow>(
    `SELECT t.id, t.bank_account_id, t.description_norm, t.amount_cents, t.kind, t.recon_status,
            EXISTS (SELECT 1 FROM match_items i WHERE i.tenant_id = t.tenant_id AND i.bank_transaction_id = t.id AND i.active)
              AS reserved
       FROM bank_transactions t
      WHERE t.tenant_id = $1 AND t.id = ANY ($2::uuid[])`,
    [tenantId, ids],
  );
  const byId = new Map(found.rows.map((row) => [row.id, row]));
  const results = new Map<string, ResultItem>();
  const eligible: TransactionRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) results.set(id, { bankTransactionId: id, status: 'skipped', reason: 'Transação não encontrada.' });
    else if (row.recon_status !== 'pending' || row.reserved) {
      results.set(id, { bankTransactionId: id, status: 'skipped', reason: 'A transação não está pendente.' });
    } else eligible.push(row);
  }
  return { eligible, results };
}

export const routes: RouteDefinition[] = [
  route({
    tags: ['ia'],
    auth: 'session',
    permission: 'reconciliation.review',
    module: 'ai.assist',
    method: 'POST',
    url: '/ai/suggest-categories',
    summary: 'Sugerir categoria por IA para transações pendentes (só sugestão, nunca confirma)',
    body: z.object({ bankTransactionIds: z.array(z.uuid()).min(1).max(MAX_TRANSACTIONS) }),
    // A chamada ao provedor (até 60 s) acontece sem transação aberta.
    transaction: 'steps',
    handler: async ({ tenantId, body, deps, transaction }) => {
      const ids = [...new Set(body.bankTransactionIds)];
      const prepared = await transaction(async ({ db }) => {
        const integrations = await db.query<IntegrationRow>(
          `SELECT * FROM integrations
            WHERE tenant_id = $1 AND kind = 'ai_provider' AND active AND status = 'verified'
            ORDER BY last_checked_at DESC NULLS LAST, id LIMIT 1`,
          [tenantId],
        );
        const integration = integrations.rows[0];
        if (!integration) {
          throw conflict('Nenhuma integração de IA verificada. Cadastre e teste o provedor antes de usar.', 'integration_not_configured');
        }
        const { eligible, results } = await eligibleTransactions(db, tenantId, ids);
        const categories = await db.query<{ id: string; name: string }>(
          'SELECT id, name FROM categories WHERE tenant_id = $1 AND active ORDER BY name, id',
          [tenantId],
        );
        if (eligible.length > 0 && categories.rows.length === 0) {
          throw conflict('Cadastre categorias antes de pedir sugestões.', 'no_categories');
        }
        return { integration, eligible, results, categories: categories.rows };
      });
      const { integration, eligible, results, categories } = prepared;
      const config = aiProviderConfigSchema.parse(integration.config);

      // Referências locais à chamada: nenhum identificador interno nem valor sai do sistema.
      const transactions: AiTransactionInputV1[] = eligible.map((row, index) => ({
        ref: `t${index + 1}`,
        descriptionNorm: row.description_norm,
        direction: Number(row.amount_cents) > 0 ? 'in' : 'out',
        kind: row.kind,
      }));
      const categoryInputs: AiCategoryInputV1[] = categories.map((row, index) => ({ ref: `c${index + 1}`, name: row.name }));
      const categoryByRef = new Map(categoryInputs.map((item, index) => [item.ref, categories[index]!]));
      const rowByRef = new Map(transactions.map((item, index) => [item.ref, eligible[index]!]));

      let suggestions: AiCategorySuggestionV1[] = [];
      if (eligible.length > 0) {
        let secret: string | null = null;
        try {
          secret = readSecret(deps.config, integration);
          if (!secret) throw new AiProviderError('Chave de API do provedor de IA não configurada.', 'rejected');
          suggestions = await createAnthropicProvider(config, secret, {
            allowPrivate: deps.config.allowPrivateIntegrationHosts,
          }).suggestCategories({ transactions, categories: categoryInputs });
        } catch (error) {
          const failure =
            error instanceof AiProviderError ? error : new AiProviderError('Falha ao chamar o provedor de IA.', 'unreachable');
          const message = scrubSecret(failure.message, secret).slice(0, ERROR_LIMIT);
          if (failure.kind !== 'invalid_response') {
            // Provedor não alcançado ou recusou: deixa de estar verificado (se não mudou durante a chamada).
            await transaction(({ db }) => recordCheck(db, integration, message));
          }
          throw new AppError(
            502,
            failure.kind === 'invalid_response' ? 'ai_invalid_response' : 'ai_provider_error',
            `${message} Nenhuma sugestão foi gravada.`,
          );
        }
      }

      return transaction(async ({ db, audit }) => {
        // A situação pode ter mudado durante a chamada: só grava para quem continua pendente.
        const still = new Set((await eligibleTransactions(db, tenantId, eligible.map((row) => row.id))).eligible.map((row) => row.id));
        const suggested = new Map(suggestions.map((item) => [item.transactionRef, item]));
        for (const [ref, row] of rowByRef) {
          if (!still.has(row.id)) {
            results.set(row.id, { bankTransactionId: row.id, status: 'skipped', reason: 'A transação não está pendente.' });
            continue;
          }
          const suggestion = suggested.get(ref);
          const category = suggestion?.categoryRef ? categoryByRef.get(suggestion.categoryRef) : undefined;
          if (!suggestion || !category) {
            results.set(row.id, {
              bankTransactionId: row.id,
              status: 'no_suggestion',
              rationale: suggestion?.rationale ?? 'O provedor não sugeriu categoria.',
            });
            continue;
          }
          // Sugestão anterior de IA para a mesma transação é substituída pela nova.
          await db.query(
            `UPDATE matches m SET status = 'superseded'
              WHERE m.tenant_id = $1 AND m.origin = 'ai' AND m.status = 'suggested'
                AND EXISTS (SELECT 1 FROM match_items i WHERE i.tenant_id = m.tenant_id AND i.match_id = m.id
                             AND i.bank_transaction_id = $2)`,
            [tenantId, row.id],
          );
          const confidence = Math.round(suggestion.confidence * 10_000) / 10_000;
          const inserted = await db.query<{ id: string }>(
            `INSERT INTO matches
               (tenant_id, bank_account_id, match_type, status, origin, rule_code, engine_version, confidence, breakdown,
                explanation, category_id, pair_key)
             VALUES ($1, $2, 'classification', 'suggested', 'ai', 'ai.category', $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
              tenantId,
              row.bank_account_id,
              `${config.provider}:${config.model}`,
              confidence,
              JSON.stringify({ source: 'ai', provider: config.provider, model: config.model, integrationId: integration.id }),
              `Sugestão de IA: ${category.name}. ${suggestion.rationale}`.slice(0, 1_000),
              category.id,
              pairKey([row.id], []),
            ],
          );
          const matchId = inserted.rows[0]!.id;
          await db.query(
            `INSERT INTO match_items (tenant_id, match_id, side, bank_transaction_id, active) VALUES ($1, $2, 'bank', $3, false)`,
            [tenantId, matchId, row.id],
          );
          results.set(row.id, {
            bankTransactionId: row.id,
            status: 'suggested',
            matchId,
            categoryId: category.id,
            confidence,
            rationale: suggestion.rationale,
          });
        }

        const items = ids.map((id) => results.get(id)!);
        const count = (status: ResultItem['status']) => items.filter((item) => item.status === status).length;
        await audit({
          action: 'ai.categories_suggested',
          entityType: 'integration',
          entityId: integration.id,
          summary: `Sugestões de categoria por IA: ${count('suggested')} sugerida(s), ${count('no_suggestion')} sem sugestão, ${count('skipped')} ignorada(s)`,
          after: { suggested: count('suggested'), noSuggestion: count('no_suggestion'), skipped: count('skipped') },
          metadata: { provider: config.provider, model: config.model, bankTransactionIds: ids },
        });
        return { items };
      });
    },
  }),
];
