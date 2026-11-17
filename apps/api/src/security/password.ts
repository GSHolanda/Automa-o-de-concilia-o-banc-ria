import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Hash de senha com scrypt. Formato: scrypt$N$r$p$sal$hash (sal e hash em base64).
 * Os parâmetros ficam gravados com o hash, de modo que o custo pode subir sem invalidar senhas antigas.
 */
const KEY_LENGTH = 64;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;

function derive(password: string, salt: Buffer, cost: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N: cost, r, p, maxmem: 256 * cost * r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string, costLog2: number): Promise<string> {
  const cost = 2 ** costLog2;
  const salt = randomBytes(16);
  const key = await derive(password, salt, cost, BLOCK_SIZE, PARALLELIZATION);
  return ['scrypt', cost, BLOCK_SIZE, PARALLELIZATION, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(cost) || cost < 2 ** 10 || cost > 2 ** 20 || r !== BLOCK_SIZE || p !== PARALLELIZATION) {
    return false;
  }
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, salt, cost, r, p);
  return timingSafeEqual(actual, expected);
}

/** Senha temporária legível, sem caracteres ambíguos. O usuário é obrigado a trocá-la no primeiro acesso. */
export function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let result = '';
  for (const byte of bytes) result += alphabet[byte % alphabet.length];
  return `${result.slice(0, 4)}-${result.slice(4, 8)}-${result.slice(8, 12)}-${result.slice(12, 16)}`;
}

export interface PasswordPolicy {
  minLength: number;
}

/** Devolve a mensagem do primeiro problema encontrado, ou nulo se a senha é aceitável. */
export function passwordProblem(password: string, policy: PasswordPolicy, email?: string): string | null {
  if (password.length < policy.minLength) return `A senha deve ter ao menos ${policy.minLength} caracteres.`;
  if (password.length > 200) return 'A senha deve ter no máximo 200 caracteres.';
  if (new Set(password).size < 5) return 'A senha é repetitiva demais.';
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
    return 'A senha não pode conter o seu e-mail.';
  }
  if (isCommonPassword(password)) {
    return 'A senha é comum demais (palavra conhecida com números ou símbolos). Use uma frase ou combinação própria.';
  }
  return null;
}

/** Palavras das senhas mais usadas; com números e símbolos em volta continuam fáceis de adivinhar. */
const COMMON_WORDS = new Set([
  '',
  'senha',
  'password',
  'passw',
  'pass',
  'admin',
  'administrador',
  'qwerty',
  'qwertyuiop',
  'asdf',
  'asdfgh',
  'zxcvbn',
  'qazwsx',
  'abc',
  'abcdef',
  'abcdefgh',
  'teste',
  'test',
  'brasil',
  'mudar',
  'mudarsenha',
  'trocar',
  'bemvindo',
  'welcome',
  'iloveyou',
  'letmein',
  'usuario',
  'acesso',
  'login',
  'empresa',
  'financeiro',
  'concilia',
]);

/** A senha é só uma palavra comum (sem acentos, sem diferença de maiúsculas) cercada de números e símbolos. */
function isCommonPassword(password: string): boolean {
  const letters = password
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return COMMON_WORDS.has(letters);
}
