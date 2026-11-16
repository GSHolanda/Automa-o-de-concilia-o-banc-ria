import { open, rm, type FileHandle } from 'node:fs/promises';
import pg from 'pg';
import { writeAudit } from '../audit/audit';
import {
  findTenantBySlug,
  ownerClient,
  parentsFirst,
  tenantTables,
  TenantOpsError,
  uuidLiteral,
} from './tenant-data';

export { TenantOpsError } from './tenant-data';

export interface ExportTenantOptions {
  /** Papel dono do esquema (MIGRATION_DATABASE_URL). */
  connectionString: string;
  slug: string;
  /** Arquivo de saída (NDJSON). Não é sobrescrito se já existir. */
  out: string;
  /** Inclui o conteúdo dos arquivos originais (`import_files`), em base64. */
  includeFiles?: boolean;
}

export interface ExportTenantResult {
  tenantId: string;
  rows: number;
  tables: Record<string, number>;
}

export const EXPORT_FORMAT = 'concilia.tenant-export';
export const EXPORT_FORMAT_VERSION = 1;

/** Tabelas que não saem na exportação: sessões são credenciais de acesso, não dados da empresa. */
const EXCLUDED_TABLES = new Set(['sessions']);
/**
 * Colunas nunca exportadas: hash de senha, segredo cifrado e hash de token. A expressão vale também para
 * tabelas futuras com nomes no mesmo padrão.
 */
const EXCLUDED_COLUMN = /password|passwd|senha|ciphertext|token_hash|secret_value/i;
const FETCH_SIZE = 500;

function serialize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value instanceof Date) return value.toISOString();
  return value;
}

function rowObject(row: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) data[key] = serialize(value);
  return data;
}

async function exportedColumns(client: pg.Client, table: string): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT attname AS name FROM pg_attribute
      WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    [`public.${pg.escapeIdentifier(table)}`],
  );
  return result.rows.map((row) => row.name).filter((name) => !EXCLUDED_COLUMN.test(name));
}

/**
 * Exporta todos os dados de uma empresa em NDJSON: uma linha de cabeçalho, uma por registro
 * (`{"type":"row","table":...,"data":...}`) e um resumo com as contagens. Lê tudo em uma transação
 * somente leitura e de leitura repetível (fotografia consistente). Sem segredos, hashes de senha nem tokens.
 */
export async function exportTenant(options: ExportTenantOptions): Promise<ExportTenantResult> {
  const client = await ownerClient(options.connectionString);
  let handle: FileHandle | null = null;
  let created = false;
  let completed = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tenant = await findTenantBySlug(client, options.slug);
    try {
      handle = await open(options.out, 'wx', 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new TenantOpsError(`O arquivo ${options.out} já existe; escolha outro destino.`);
      }
      throw error;
    }
    const output = handle;
    const write = (line: unknown) => output.write(`${JSON.stringify(line)}\n`);

    const schema = await client.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1');
    await write({
      type: 'header',
      format: EXPORT_FORMAT,
      version: EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      schemaVersion: schema.rows[0]?.name ?? null,
      includeFiles: options.includeFiles === true,
      tenant: { id: tenant.id, slug: tenant.slug, legalName: tenant.legal_name, tradeName: tenant.trade_name },
      excluded: { tables: [...EXCLUDED_TABLES], columns: EXCLUDED_COLUMN.source },
    });

    const counts: Record<string, number> = {};
    let total = 0;
    const tenantLiteral = uuidLiteral(tenant.id);
    const tenantRow = await client.query(`SELECT * FROM tenants WHERE id = ${tenantLiteral}`);
    await write({ type: 'row', table: 'tenants', data: rowObject(tenantRow.rows[0] as Record<string, unknown>) });
    counts.tenants = 1;
    total += 1;

    for (const table of parentsFirst(await tenantTables(client))) {
      if (EXCLUDED_TABLES.has(table.name)) continue;
      if (table.name === 'import_files' && !options.includeFiles) continue;
      const columns = await exportedColumns(client, table.name);
      const order = table.primaryKey.length > 0 ? ` ORDER BY ${table.primaryKey.map((c) => pg.escapeIdentifier(c)).join(', ')}` : '';
      await client.query(
        `DECLARE export_rows NO SCROLL CURSOR FOR
           SELECT ${columns.map((c) => pg.escapeIdentifier(c)).join(', ')}
             FROM ${pg.escapeIdentifier(table.name)} WHERE tenant_id = ${tenantLiteral}${order}`,
      );
      let count = 0;
      for (;;) {
        const batch = await client.query<Record<string, unknown>>(`FETCH ${FETCH_SIZE} FROM export_rows`);
        if (batch.rows.length === 0) break;
        const chunk = batch.rows.map((row) => JSON.stringify({ type: 'row', table: table.name, data: rowObject(row) }));
        await output.write(`${chunk.join('\n')}\n`);
        count += batch.rows.length;
      }
      await client.query('CLOSE export_rows');
      counts[table.name] = count;
      total += count;
    }
    await write({ type: 'summary', rows: total, tables: counts });
    await output.close();
    handle = null;
    await client.query('COMMIT');

    // Evidência na trilha da própria empresa: quem exportou não aparece nos dados, só a quantidade.
    await client.query('BEGIN');
    await writeAudit(client, {
      tenantId: tenant.id,
      actor: { type: 'system', id: null, label: 'cli tenant:export' },
      action: 'tenant.data_exported',
      entityType: 'tenant',
      entityId: tenant.id,
      summary: `Dados da empresa exportados (${total} registro(s))`,
      metadata: { rows: total, tables: counts, includeFiles: options.includeFiles === true },
    });
    await client.query('COMMIT');
    completed = true;
    return { tenantId: tenant.id, rows: total, tables: counts };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    // Exportação incompleta não fica no disco.
    if (!completed && created) await rm(options.out, { force: true }).catch(() => undefined);
    await client.end();
  }
}
