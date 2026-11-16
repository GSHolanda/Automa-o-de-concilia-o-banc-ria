/** Erro previsto da aplicação: vira resposta HTTP com código estável e mensagem em português. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthenticated = (message = 'Autenticação necessária.', code = 'unauthenticated') =>
  new AppError(401, code, message);
export const forbidden = (message = 'Você não tem permissão para esta operação.', code = 'forbidden') =>
  new AppError(403, code, message);
/** Recurso inexistente ou de outra empresa: a resposta é a mesma nos dois casos. */
export const notFound = (message = 'Registro não encontrado.') => new AppError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict', details?: unknown) =>
  new AppError(409, code, message, details);
/** Recurso que existiu e foi removido de propósito (ex.: arquivo expurgado pela retenção). */
export const gone = (message: string, code = 'gone', details?: unknown) => new AppError(410, code, message, details);
export const unprocessable = (message: string, code = 'unprocessable', details?: unknown) =>
  new AppError(422, code, message, details);

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

/** Converte violações de restrição do banco em erros compreensíveis, sem expor detalhes internos. */
export function fromDatabaseError(error: unknown): AppError | null {
  const pgError = error as PgError;
  if (typeof pgError?.code !== 'string') return null;
  switch (pgError.code) {
    case '23505':
      return conflict('Já existe um registro com estes dados.', 'duplicate', { constraint: pgError.constraint });
    case '23503':
      return conflict('O registro está em uso ou faz referência a um item inexistente.', 'reference', {
        constraint: pgError.constraint,
      });
    case '23514':
    case '23502':
    case '22P02':
    case '22001':
      return badRequest('Dados inválidos.', 'invalid_data', { constraint: pgError.constraint });
    case '42501':
      return forbidden('Operação não permitida.', 'not_allowed');
    case '40001':
    case '40P01':
      return conflict('Outra operação alterou os mesmos dados. Tente novamente.', 'concurrent_update');
    default:
      return null;
  }
}
