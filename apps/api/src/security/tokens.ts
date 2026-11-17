import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Token opaco de 256 bits, em base64url. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Token CSRF derivado da sessão: não precisa ser armazenado e muda a cada sessão. */
export function csrfTokenFor(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const API_TOKEN_PREFIX = 'ck_';

export function generateApiToken(): { token: string; prefix: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, prefix: token.slice(0, 10) };
}
