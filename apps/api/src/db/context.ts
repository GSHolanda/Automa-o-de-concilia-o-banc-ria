import type pg from 'pg';

/**
 * Contexto de uma transação. As políticas RLS do banco usam estes valores:
 * sem tenantId nenhuma linha de empresa é visível; platform libera apenas as tabelas da plataforma.
 */
export interface DbContext {
  tenantId?: string | null;
  userId?: string | null;
  platform?: boolean;
}

/** Conexão dentro de uma transação com contexto definido. */
export type Db = Pick<pg.PoolClient, 'query'>;

/**
 * Executa `fn` em uma transação com o contexto da requisição.
 * O contexto é definido com escopo de transação: ao devolver a conexão ao pool, ele deixa de existir.
 */
export async function withContext<T>(pool: pg.Pool, context: DbContext, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.platform', $3, true)`,
      [context.tenantId ?? '', context.userId ?? '', context.platform ? 'on' : 'off'],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Recusa iniciar se a conexão de execução puder ignorar o isolamento entre empresas:
 * superusuário, BYPASSRLS ou dono de tabelas (o dono não é sujeito às políticas).
 */
export async function assertSafeRuntimeRole(pool: pg.Pool): Promise<void> {
  const role = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const current = role.rows[0];
  if (!current) throw new Error('Não foi possível identificar o papel de banco em uso');
  if (current.rolsuper || current.rolbypassrls) {
    throw new Error(
      `O papel "${current.rolname}" é superusuário ou ignora RLS. Configure DATABASE_URL com o papel da aplicação.`,
    );
  }
  const owned = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`,
  );
  if ((owned.rows[0]?.total ?? 0) > 0) {
    throw new Error(
      `O papel "${current.rolname}" é dono de tabelas e por isso não é limitado por RLS. ` +
        'Use o papel dono apenas em MIGRATION_DATABASE_URL.',
    );
  }
}
