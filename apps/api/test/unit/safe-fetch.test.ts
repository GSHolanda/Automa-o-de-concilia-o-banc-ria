import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBlockedAddress, safeFetch, SafeFetchError } from '../../src/integrations/http';

// Servidor HTTP local de teste: nenhum serviço externo é chamado.
let server: Server;
let base: string;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/destino' });
      res.end();
      return;
    }
    if (req.url === '/grande') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(Buffer.alloc(4096, 97));
      return;
    }
    if (req.url === '/lento') {
      setTimeout(() => res.end('tarde'), 1_000);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-teste': 'sim' });
      res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), auth: req.headers.authorization ?? null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('isBlockedAddress', () => {
  it('recusa privados, loopback, link-local, metadados e IPv4 mapeado em IPv6', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.3.4',
      '192.168.0.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fd00:ec2::254',
      'fc00::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedAddress(address, false), address).toBe(true);
    }
    expect(isBlockedAddress('93.184.216.34', false)).toBe(false);
    expect(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946', false)).toBe(false);
  });

  it('com endereços privados liberados, metadados continuam recusados', () => {
    expect(isBlockedAddress('127.0.0.1', true)).toBe(false);
    expect(isBlockedAddress('10.0.0.5', true)).toBe(false);
    expect(isBlockedAddress('169.254.169.254', true)).toBe(true);
    expect(isBlockedAddress('fd00:ec2::254', true)).toBe(true);
  });
});

describe('safeFetch recusando endereço privado quando não liberado', () => {
  it('HTTP sem liberação é recusado antes de qualquer conexão', async () => {
    const before = hits.length;
    await expect(safeFetch(`${base}/eco`, {}, { allowPrivate: false })).rejects.toMatchObject({ code: 'protocol_not_allowed' });
    expect(hits.length).toBe(before);
  });

  it('HTTPS para loopback, rede privada, metadados e localhost é recusado', async () => {
    for (const url of [
      'https://127.0.0.1/',
      'https://10.1.2.3/',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/',
      'https://localhost/',
    ]) {
      await expect(safeFetch(url, {}, { allowPrivate: false }), url).rejects.toMatchObject({ code: 'blocked_address' });
    }
  });

  it('metadados são recusados mesmo com liberação', async () => {
    await expect(safeFetch('http://169.254.169.254/', {}, { allowPrivate: true })).rejects.toBeInstanceOf(SafeFetchError);
  });
});

describe('safeFetch contra servidor HTTP local de teste (liberado)', () => {
  it('faz GET e POST com cabeçalhos e corpo', async () => {
    const response = await safeFetch(
      `${base}/eco`,
      { method: 'POST', headers: { authorization: 'Bearer abc', 'content-type': 'application/json' }, body: '{"a":1}' },
      { allowPrivate: true },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-teste')).toBe('sim');
    expect(await response.json()).toEqual({ method: 'POST', body: '{"a":1}', auth: 'Bearer abc' });
  });

  it('não segue redirecionamento', async () => {
    const response = await safeFetch(`${base}/redirect`, {}, { allowPrivate: true });
    expect(response.status).toBe(302);
    expect(hits).not.toContain('/destino');
  });

  it('limita o tamanho da resposta', async () => {
    await expect(safeFetch(`${base}/grande`, {}, { allowPrivate: true, maxBytes: 1024 })).rejects.toMatchObject({
      code: 'response_too_large',
    });
  });

  it('respeita o tempo limite', async () => {
    await expect(safeFetch(`${base}/lento`, {}, { allowPrivate: true, timeoutMs: 100 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('porta sem servidor vira erro de rede', async () => {
    await expect(safeFetch('http://127.0.0.1:1/', {}, { allowPrivate: true })).rejects.toMatchObject({ code: 'network_error' });
  });
});
