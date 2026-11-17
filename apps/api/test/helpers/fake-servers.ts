import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as netCreateServer, type AddressInfo } from 'node:net';

/**
 * Servidores HTTP locais de teste. Simulam serviços externos (webhook, API do sistema financeiro,
 * provedor de IA) em 127.0.0.1: nada aqui fala com um serviço real.
 */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface LocalTestServer {
  url: string;
  requests: RecordedRequest[];
  /** Troca a resposta do servidor. */
  respond: (handler: (request: RecordedRequest, res: ServerResponse) => void) => void;
  close: () => Promise<void>;
}

export async function startLocalTestServer(
  initial: (request: RecordedRequest, res: ServerResponse) => void = (_request, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  },
): Promise<LocalTestServer> {
  let handler = initial;
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    respond: (next) => {
      handler = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Resposta no formato da API de mensagens, com o texto indicado. */
export function fakeMessage(text: string, stopReason = 'end_turn') {
  return {
    id: 'msg_teste_local',
    type: 'message',
    role: 'assistant',
    model: 'modelo-de-teste',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

export interface LocalSmtpServer {
  port: number;
  messages: { from: string; to: string[]; data: string }[];
  close: () => Promise<void>;
}

/** Servidor SMTP local de teste, mínimo (sem TLS e sem autenticação). Não entrega nada a ninguém. */
export async function startLocalSmtpServer(): Promise<LocalSmtpServer> {
  const messages: LocalSmtpServer['messages'] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = netCreateServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let inData = false;
    let current = { from: '', to: [] as string[], data: '' };
    socket.write('220 smtp.local.test ESMTP servidor de teste\r\n');
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          messages.push(current);
          current = { from: '', to: [], data: '' };
          inData = false;
          socket.write('250 2.0.0 aceito\r\n');
          continue;
        }
        const index = buffer.indexOf('\r\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250-smtp.local.test\r\n250 8BITMIME\r\n');
        else if (command === 'MAIL') {
          current.from = line;
          socket.write('250 2.1.0 ok\r\n');
        } else if (command === 'RCPT') {
          current.to.push(line);
          socket.write('250 2.1.5 ok\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 envie\r\n');
        } else if (command === 'QUIT') {
          socket.end('221 2.0.0 tchau\r\n');
          return;
        } else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Endereço local em que nada escuta: integração inalcançável. */
export const UNREACHABLE_URL = 'http://127.0.0.1:1';
