/** Cliente HTTP da interface: JSON, CSRF, erros tipados, multipart e download. */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

const BASE = '/api/v1';
let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Chamado quando a API responde 401 fora das telas de autenticação (leva ao login). */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export type QueryValue = string | number | boolean | null | undefined;

export function withQuery(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}${path.includes('?') ? '&' : '?'}${text}` : path;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, QueryValue>;
  form?: FormData;
  signal?: AbortSignal;
  /** Não trata 401 como sessão expirada (usado no login e em /auth/me). */
  skipUnauthorized?: boolean;
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'http_error';
  let message = `Falha na requisição (${response.status}).`;
  let details: unknown;
  let requestId: string | undefined;
  try {
    const data = (await response.json()) as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } };
    if (data.error) {
      code = data.error.code ?? code;
      message = data.error.message ?? message;
      details = data.error.details;
      requestId = data.error.requestId;
    }
  } catch {
    /* corpo sem JSON */
  }
  return new ApiError(response.status, code, message, details, requestId);
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let response: Response;
  try {
    response = await fetch(`${BASE}${withQuery(path, options.query)}`, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network_error', 'Não foi possível conectar ao servidor. Verifique a conexão.');
  }
  if (!response.ok) {
    const error = await toApiError(response);
    if (response.status === 401 && !options.skipUnauthorized) unauthorizedHandler?.();
    throw error;
  }
  return response;
}

async function json<T>(path: string, options: RequestOptions): Promise<T> {
  const response = await send(path, options);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal, skipUnauthorized = false) =>
    json<T>(path, { query, signal, skipUnauthorized }),
  post: <T>(path: string, body?: unknown, skipUnauthorized = false) =>
    json<T>(path, { method: 'POST', body, skipUnauthorized }),
  put: <T>(path: string, body?: unknown) => json<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => json<T>(path, { method: 'PATCH', body }),
  delete: <T = void>(path: string) => json<T>(path, { method: 'DELETE' }),
  /** Envio multipart (arquivos). Não define Content-Type: o navegador inclui o boundary. */
  upload: <T>(path: string, form: FormData, method = 'POST') => json<T>(path, { method, form }),
  /** Baixa um arquivo e dispara o salvamento no navegador. */
  async download(path: string, query?: Record<string, QueryValue>, fallbackName = 'arquivo'): Promise<void> {
    const response = await send(path, { query });
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const name = match?.[1] ? decodeURIComponent(match[1]) : fallbackName;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },
};

/** Lista no formato padrão da API. */
export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Ocorreu um erro inesperado.';
}
