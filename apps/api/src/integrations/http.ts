import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Saída HTTP para serviços das empresas (webhook, conector, IA), com proteção contra SSRF:
 * só HTTPS (HTTP apenas com liberação de desenvolvimento), DNS resolvido e conferido antes da conexão
 * (a conexão usa o endereço conferido), sem redirecionamento, tempo limite e tamanho máximo de resposta.
 */

export type SafeFetchErrorCode =
  | 'invalid_url'
  | 'protocol_not_allowed'
  | 'blocked_address'
  | 'dns_error'
  | 'timeout'
  | 'response_too_large'
  | 'network_error'
  | 'aborted';

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchOptions {
  /** Libera HTTP e endereços privados (apenas desenvolvimento e testes). Metadados continuam recusados. */
  allowPrivate: boolean;
  /** Tempo limite total. Padrão: 10 s. */
  timeoutMs?: number;
  /** Tamanho máximo da resposta. Padrão: 5 MB. */
  maxBytes?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** Serviços de metadados de nuvem: recusados sempre, mesmo com a liberação de desenvolvimento. */
const metadata = new BlockList();
metadata.addAddress('169.254.169.254', 'ipv4');
metadata.addAddress('169.254.170.2', 'ipv4');
metadata.addAddress('100.100.100.200', 'ipv4');
metadata.addAddress('fd00:ec2::254', 'ipv6');

function mappedIpv4(address: string): string | null {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match ? match[1]! : null;
}

export function isBlockedAddress(address: string, allowPrivate: boolean): boolean {
  const v4 = mappedIpv4(address);
  const ip = v4 ?? address;
  const family = isIP(ip);
  if (family === 0) return true;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (metadata.check(ip, type)) return true;
  if (allowPrivate) return false;
  return blocked.check(ip, type);
}

/** Resolve o nome e devolve um endereço permitido. Qualquer endereço proibido na resolução recusa o destino. */
export async function resolveSafeAddress(host: string, allowPrivate: boolean): Promise<{ address: string; family: 4 | 6 }> {
  const bare = host.replace(/^\[|\]$/g, '');
  const literal = isIP(bare);
  let addresses: { address: string; family: number }[];
  if (literal !== 0) {
    addresses = [{ address: bare, family: literal }];
  } else {
    try {
      addresses = await lookup(bare, { all: true, verbatim: true });
    } catch {
      throw new SafeFetchError('dns_error', `Não foi possível resolver o endereço ${bare}.`);
    }
  }
  if (addresses.length === 0) throw new SafeFetchError('dns_error', `Não foi possível resolver o endereço ${bare}.`);
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address, allowPrivate)) {
      throw new SafeFetchError(
        'blocked_address',
        `Destino recusado: ${bare} aponta para endereço privado, de loopback, link-local ou de metadados.`,
      );
    }
  }
  const first = addresses[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** Confere protocolo e endereço de um destino sem conectar. */
export async function assertSafeUrl(url: string | URL, allowPrivate: boolean): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new SafeFetchError('invalid_url', 'Endereço inválido.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowPrivate)) {
    throw new SafeFetchError('protocol_not_allowed', 'Somente endereços HTTPS são permitidos.');
  }
  await resolveSafeAddress(parsed.hostname, allowPrivate);
  return parsed;
}

function bodyOf(body: RequestInit['body']): Buffer | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new SafeFetchError('network_error', 'Tipo de corpo de requisição não suportado.');
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/** Equivalente restrito de `fetch`. Devolve a resposta sem seguir redirecionamento. */
export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions,
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new SafeFetchError('invalid_url', 'Endereço inválido.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowPrivate)) {
    throw new SafeFetchError('protocol_not_allowed', 'Somente endereços HTTPS são permitidos.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const target = await resolveSafeAddress(host, options.allowPrivate);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const payload = bodyOf(init.body);
  const headers = new Headers(init.headers);
  if (payload && !headers.has('content-length')) headers.set('content-length', String(payload.length));

  // A conexão usa o endereço já conferido: uma nova resolução não troca o destino (DNS rebinding).
  const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
  const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const signal = init.signal ?? undefined;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: SafeFetchError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      req.destroy();
      reject(error);
    };
    const req = requester(
      url,
      {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        lookup: pinned,
        ...(url.protocol === 'https:' && isIP(host) === 0 ? { servername: host } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            fail(new SafeFetchError('response_too_large', `A resposta excedeu o limite de ${maxBytes} bytes.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => fail(new SafeFetchError('network_error', 'A conexão foi interrompida durante a resposta.')));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const status = res.statusCode ?? 0;
          if (status < 200 || status > 599) {
            reject(new SafeFetchError('network_error', `Resposta HTTP inválida (${status}).`));
            return;
          }
          const noBody = status === 204 || status === 205 || status === 304 || init.method === 'HEAD';
          resolve(
            new Response(noBody ? null : Buffer.concat(chunks), {
              status,
              statusText: res.statusMessage ?? '',
              headers: responseHeaders(res),
            }),
          );
        });
      },
    );
    const timer = setTimeout(
      () => fail(new SafeFetchError('timeout', `Sem resposta em ${Math.round(timeoutMs / 1000) || 1} s.`)),
      timeoutMs,
    );
    const onAbort = () => fail(new SafeFetchError('aborted', 'Requisição cancelada.'));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (error: NodeJS.ErrnoException) =>
      fail(new SafeFetchError('network_error', `Falha de conexão com ${host}${error.code ? ` (${error.code})` : ''}.`)),
    );
    if (payload) req.write(payload);
    req.end();
  });
}
