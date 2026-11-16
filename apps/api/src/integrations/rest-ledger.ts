import {
  mapConnectorItem,
  readPath,
  type LedgerConnectorV1,
  type RestLedgerConfig,
} from '@concilia/core';
import { scrubSecret } from '../security/secrets';
import { safeFetch, SafeFetchError } from './http';

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorError';
  }
}

const MAX_ITEMS = 100_000;

function authHeaders(config: RestLedgerConfig, secret: string | null): Record<string, string> {
  if (config.authType === 'none' || !secret) return {};
  if (config.authType === 'bearer') return { authorization: `Bearer ${secret}` };
  if (config.authType === 'basic') {
    return { authorization: `Basic ${Buffer.from(`${config.headerName ?? ''}:${secret}`).toString('base64')}` };
  }
  return { [String(config.headerName)]: secret };
}

function endpoint(config: RestLedgerConfig, range: { dateFrom: string; dateTo: string }): string {
  const base = config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`;
  const url = new URL(config.path.replace(/^\//, ''), base);
  url.searchParams.set(config.dateFromParam, range.dateFrom);
  url.searchParams.set(config.dateToParam, range.dateTo);
  return url.toString();
}

/** Conector REST de leitura de lançamentos (contrato LedgerConnectorV1). */
export function createRestLedgerConnector(
  config: RestLedgerConfig,
  secret: string | null,
  options: { allowPrivate: boolean },
): LedgerConnectorV1 {
  const fetchItems = async (range: { dateFrom: string; dateTo: string }): Promise<unknown[]> => {
    let response: Response;
    try {
      response = await safeFetch(
        endpoint(config, range),
        { method: 'GET', headers: { accept: 'application/json', ...authHeaders(config, secret) } },
        { allowPrivate: options.allowPrivate },
      );
    } catch (error) {
      throw new ConnectorError(
        scrubSecret(error instanceof SafeFetchError ? error.message : 'Falha ao consultar a API de lançamentos.', secret),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ConnectorError(`A API de lançamentos respondeu HTTP ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ConnectorError('A API de lançamentos não devolveu JSON válido.');
    }
    const items = readPath(body, config.itemsPath);
    if (!Array.isArray(items)) {
      throw new ConnectorError(
        config.itemsPath
          ? `A resposta não contém uma lista em "${config.itemsPath}".`
          : 'A resposta da API de lançamentos não é uma lista.',
      );
    }
    if (items.length > MAX_ITEMS) throw new ConnectorError(`A API devolveu mais de ${MAX_ITEMS} itens.`);
    return items;
  };

  return {
    version: 'v1',
    async test() {
      const today = new Date().toISOString().slice(0, 10);
      await fetchItems({ dateFrom: today, dateTo: today });
    },
    async pull(range) {
      const raw = await fetchItems(range);
      return {
        raw,
        items: raw.map((item) => mapConnectorItem(item, config.fieldMap, { amountUnit: config.amountUnit })),
      };
    },
  };
}
