import { z } from 'zod';
import type { Db } from '../../db/context';
import { badRequest, conflict, notFound } from '../../http/errors';
import { created, noContent, route, type RouteDefinition } from '../../http/route';
import type { Entitlements } from '../tenancy/entitlements';

type Row = Record<string, unknown>;

export interface WriteContext {
  db: Db;
  tenantId: string;
  mode: 'create' | 'update';
  /** Registro atual (só em alteração). */
  existing: Row | null;
  /** Dados validados, com chaves em camelCase. */
  data: Row;
  entitlements: () => Promise<Entitlements>;
}

export interface RegistryDefinition {
  /** Caminho base, por exemplo `/categories`. */
  path: string;
  table: string;
  /** Prefixo da ação de auditoria, por exemplo `category`. */
  entity: string;
  /** Nome para mensagens, por exemplo `categoria`. */
  label: string;
  /** Campos graváveis (camelCase); a coluna é o mesmo nome em snake_case. Opcionais usam o padrão do banco. */
  shape: z.ZodRawShape;
  /** Campos jsonb. */
  jsonFields?: string[];
  /** Filtros aceitos na listagem (`?chave=`), mapeados para coluna. */
  filters?: Record<string, z.ZodType>;
  orderBy: string;
  /** Campo que identifica o registro nas mensagens e na auditoria. */
  nameField: string;
  /** Aceita `parentId` e impede ciclos na hierarquia. */
  hierarchical?: boolean;
  /** Regras adicionais antes de gravar (limites, exclusividade). */
  beforeWrite?: (context: WriteContext) => Promise<void>;
}

const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

function view(definition: RegistryDefinition, row: Row): Row {
  const result: Row = { id: row.id };
  for (const key of Object.keys(definition.shape)) {
    const value = row[snake(key)];
    result[key] = value instanceof Date ? value.toISOString() : (value ?? null);
  }
  result.createdAt = (row.created_at as Date).toISOString();
  result.updatedAt = (row.updated_at as Date).toISOString();
  return result;
}

function pgCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

async function findRow(db: Db, definition: RegistryDefinition, tenantId: string, id: string): Promise<Row> {
  const result = await db.query<Row>(`SELECT * FROM ${definition.table} WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  const row = result.rows[0];
  if (!row) throw notFound(`Registro de ${definition.label} não encontrado.`);
  return row;
}

/** Impede que um nó passe a ser descendente de si mesmo. */
async function assertNoCycle(db: Db, table: string, tenantId: string, id: string, parentId: string): Promise<void> {
  if (parentId === id) throw badRequest('Um registro não pode ser pai de si mesmo.', 'invalid_parent');
  const result = await db.query<{ id: string }>(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id FROM ${table} WHERE tenant_id = $1 AND id = $2
       UNION
       SELECT t.id, t.parent_id FROM ${table} t JOIN up ON t.id = up.parent_id WHERE t.tenant_id = $1
     ) SELECT id FROM up WHERE id = $3`,
    [tenantId, parentId, id],
  );
  if (result.rows.length > 0) throw badRequest('A hierarquia não pode formar ciclo.', 'invalid_parent');
}

function prepare(definition: RegistryDefinition, data: Row): Row {
  const json = new Set(definition.jsonFields ?? []);
  const out: Row = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    out[snake(key)] = json.has(key) && value !== null ? JSON.stringify(value) : value;
  }
  return out;
}

/** Gera listar, consultar, criar, alterar e excluir de um cadastro da empresa. */
export function registryRoutes(definition: RegistryDefinition): RouteDefinition[] {
  const createSchema = z.object(definition.shape);
  const patchSchema = createSchema.partial();
  const idParams = z.object({ id: z.uuid() });
  const querySchema = z.object(
    Object.fromEntries(Object.entries(definition.filters ?? {}).map(([key, schema]) => [key, schema.optional()])),
  );
  const tags = ['cadastros'];

  const writeError = (error: unknown): never => {
    if (pgCode(error) === '23505') {
      throw conflict(`Já existe ${definition.label} com este código ou nome.`, 'duplicate');
    }
    if (pgCode(error) === '23503') throw badRequest('Referência a registro inexistente.', 'invalid_reference');
    throw error;
  };

  return [
    route({
      tags,
      auth: 'session',
      permission: null,
      method: 'GET',
      url: definition.path,
      summary: `Listar ${definition.label}`,
      query: querySchema,
      handler: async ({ db, tenantId, query }) => {
        const params: unknown[] = [tenantId];
        const where = ['tenant_id = $1'];
        for (const [key, value] of Object.entries(query as Row)) {
          if (value === undefined) continue;
          params.push(value);
          where.push(`${snake(key)} = $${params.length}`);
        }
        const result = await db.query<Row>(
          `SELECT * FROM ${definition.table} WHERE ${where.join(' AND ')} ORDER BY ${definition.orderBy}`,
          params,
        );
        return { items: result.rows.map((row) => view(definition, row)) };
      },
    }),
    route({
      tags,
      auth: 'session',
      permission: null,
      method: 'GET',
      url: `${definition.path}/:id`,
      summary: `Consultar ${definition.label}`,
      params: idParams,
      handler: async ({ db, tenantId, params }) => view(definition, await findRow(db, definition, tenantId, params.id)),
    }),
    route({
      tags,
      auth: 'session',
      permission: 'settings.manage',
      method: 'POST',
      url: definition.path,
      summary: `Criar ${definition.label}`,
      body: createSchema,
      handler: async ({ db, tenantId, body, audit, entitlements }) => {
        const data = body as Row;
        await definition.beforeWrite?.({ db, tenantId, mode: 'create', existing: null, data, entitlements });
        const values = prepare(definition, data);
        const columns = ['tenant_id', ...Object.keys(values)];
        let row: Row;
        try {
          const result = await db.query<Row>(
            `INSERT INTO ${definition.table} (${columns.join(', ')})
             VALUES (${columns.map((_column, index) => `$${index + 1}`).join(', ')}) RETURNING *`,
            [tenantId, ...Object.values(values)],
          );
          row = result.rows[0]!;
        } catch (error) {
          return writeError(error);
        }
        const after = view(definition, row);
        await audit({
          action: `${definition.entity}.created`,
          entityType: definition.entity,
          entityId: row.id as string,
          summary: `Cadastro de ${definition.label} criado: ${String(after[definition.nameField])}`,
          after,
        });
        return created(after);
      },
    }),
    route({
      tags,
      auth: 'session',
      permission: 'settings.manage',
      method: 'PATCH',
      url: `${definition.path}/:id`,
      summary: `Alterar ${definition.label}`,
      params: idParams,
      body: patchSchema,
      handler: async ({ db, tenantId, params, body, audit, entitlements }) => {
        const existing = await findRow(db, definition, tenantId, params.id);
        const data = body as Row;
        const values = prepare(definition, data);
        if (Object.keys(values).length === 0) return view(definition, existing);
        const parentId = definition.hierarchical ? (data.parentId as string | null | undefined) : undefined;
        if (parentId) await assertNoCycle(db, definition.table, tenantId, params.id, parentId);
        await definition.beforeWrite?.({ db, tenantId, mode: 'update', existing, data, entitlements });
        const assignments = Object.keys(values).map((column, index) => `${column} = $${index + 3}`);
        let row: Row;
        try {
          const result = await db.query<Row>(
            `UPDATE ${definition.table} SET ${assignments.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
            [tenantId, params.id, ...Object.values(values)],
          );
          row = result.rows[0]!;
        } catch (error) {
          return writeError(error);
        }
        const after = view(definition, row);
        await audit({
          action: `${definition.entity}.updated`,
          entityType: definition.entity,
          entityId: params.id,
          summary: `Cadastro de ${definition.label} alterado: ${String(after[definition.nameField])}`,
          before: view(definition, existing),
          after,
        });
        return after;
      },
    }),
    route({
      tags,
      auth: 'session',
      permission: 'settings.manage',
      method: 'DELETE',
      url: `${definition.path}/:id`,
      summary: `Excluir ${definition.label}`,
      params: idParams,
      handler: async ({ db, tenantId, params, audit }) => {
        const existing = await findRow(db, definition, tenantId, params.id);
        try {
          await db.query(`DELETE FROM ${definition.table} WHERE tenant_id = $1 AND id = $2`, [tenantId, params.id]);
        } catch (error) {
          if (pgCode(error) === '23503') {
            throw conflict(
              `Este cadastro de ${definition.label} está em uso e não pode ser excluído. Desative-o, se preferir.`,
              'in_use',
            );
          }
          throw error;
        }
        const before = view(definition, existing);
        await audit({
          action: `${definition.entity}.deleted`,
          entityType: definition.entity,
          entityId: params.id,
          summary: `Cadastro de ${definition.label} excluído: ${String(before[definition.nameField])}`,
          before,
        });
        return noContent();
      },
    }),
  ];
}
