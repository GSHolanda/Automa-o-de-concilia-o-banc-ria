import pg from 'pg';
// Efeito colateral: datas civis chegam como texto AAAA-MM-DD, como na aplicação.
import '../db/pool';

/** Falha prevista dos comandos de dados por empresa (exportação e eliminação). */
export class TenantOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantOpsError';
  }
}

export interface TenantRow {
  id: string;
  slug: string;
  legal_name: string;
  trade_name: string;
  status: string;
}

export interface TenantTable {
  name: string;
  /** Colunas da chave primária, para ordenar a exportação. */
  primaryKey: string[];
  /** Tabelas desta lista que esta referencia por chave estrangeira. */
  references: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Conexão direta com o papel dono do esquema (não sujeito a RLS). Uso exclusivo da CLI de operação. */
export async function ownerClient(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString, application_name: 'concilia-cli' });
  await client.connect();
  return client;
}

export async function findTenantBySlug(client: Pick<pg.Client, 'query'>, slug: string, lock = false): Promise<TenantRow> {
  const result = await client.query<TenantRow>(
    `SELECT id, slug, legal_name, trade_name, status FROM tenants WHERE slug = $1${lock ? ' FOR UPDATE' : ''}`,
    [slug],
  );
  const row = result.rows[0];
  if (!row) throw new TenantOpsError(`Empresa "${slug}" não encontrada.`);
  return row;
}

/** Literal SQL de um uuid já lido do banco (DECLARE CURSOR não aceita parâmetros). */
export function uuidLiteral(id: string): string {
  if (!UUID.test(id)) throw new TenantOpsError('Identificador de empresa inválido.');
  return `'${id}'::uuid`;
}

/**
 * Tabelas de dados de empresa, descobertas pelo catálogo: toda tabela do esquema public com coluna `tenant_id`.
 * Tabelas criadas por migrações futuras entram sem alteração de código.
 */
export async function tenantTables(client: Pick<pg.Client, 'query'>): Promise<TenantTable[]> {
  const tables = await client.query<{ name: string; pk: string[] | null }>(
    `SELECT c.relname AS name,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM pg_index i
               CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
              WHERE i.indrelid = c.oid AND i.indisprimary) AS pk
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
      ORDER BY c.relname`,
  );
  const names = new Set(tables.rows.map((row) => row.name));
  const edges = await client.query<{ child: string; parent: string }>(
    `SELECT DISTINCT child.relname AS child, parent.relname AS parent
       FROM pg_constraint k
       JOIN pg_class child ON child.oid = k.conrelid
       JOIN pg_class parent ON parent.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE k.contype = 'f' AND n.nspname = 'public'`,
  );
  return tables.rows.map((row) => ({
    name: row.name,
    primaryKey: row.pk ?? [],
    references: edges.rows
      .filter((edge) => edge.child === row.name && edge.parent !== row.name && names.has(edge.parent))
      .map((edge) => edge.parent),
  }));
}

/** Ordem com as tabelas referenciadas antes das que as referenciam (inverta para apagar). */
export function parentsFirst(tables: TenantTable[]): TenantTable[] {
  const pending = new Map(tables.map((table) => [table.name, table]));
  const ordered: TenantTable[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((table) => table.references.every((parent) => !pending.has(parent)));
    if (ready.length === 0) {
      throw new TenantOpsError(`Referência circular entre tabelas: ${[...pending.keys()].join(', ')}.`);
    }
    for (const table of ready) {
      ordered.push(table);
      pending.delete(table.name);
    }
  }
  return ordered;
}
