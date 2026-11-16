import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export interface DemoResponse {
  status: number;
  body: any;
}

/** Cliente mínimo sobre `app.inject`: usa as mesmas rotas, sessão e CSRF de um navegador. */
export class DemoClient {
  private cookie = '';
  private csrf = '';

  constructor(private readonly app: FastifyInstance) {}

  async login(email: string, password: string): Promise<void> {
    const response = await this.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    if (response.statusCode !== 200) throw new Error(`Login de ${email} falhou (${response.statusCode}).`);
    const setCookie = response.headers['set-cookie'];
    this.cookie = String((Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? '').split(';')[0] ?? '';
    this.csrf = (response.json() as { csrfToken: string }).csrfToken;
  }

  private async send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) {
    const response = await this.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie: this.cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': this.csrf }), ...headers },
      ...(payload === undefined ? {} : { payload: payload as object | Buffer }),
    });
    const isJson = String(response.headers['content-type'] ?? '').includes('application/json');
    return { status: response.statusCode, body: isJson ? response.json() : response.body } satisfies DemoResponse;
  }

  /** Executa a chamada e falha com a mensagem da API se o status não for o esperado. */
  async expect(status: number, call: Promise<DemoResponse>, what: string): Promise<any> {
    const response = await call;
    if (response.status !== status) {
      throw new Error(`${what}: resposta ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body;
  }

  get = (url: string) => this.send('GET', url);
  post = (url: string, payload?: unknown) => this.send('POST', url, payload ?? {});
  put = (url: string, payload?: unknown) => this.send('PUT', url, payload ?? {});

  /** POST /imports com o arquivo em multipart. */
  upload(fields: Record<string, string | undefined>, file: { name: string; content: Buffer }) {
    const boundary = `----concilia${randomBytes(8).toString('hex')}`;
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      file.content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return this.send('POST', '/imports', Buffer.concat(parts), {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    });
  }
}
