import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cofre de segredos de integração (ADR-11): AES-256-GCM com a chave mestra da implantação.
 * Formato: versão da chave (1 byte) | iv (12) | tag (16) | texto cifrado.
 * Os dados autenticados adicionais (`tenantId:integrationId`) impedem mover o texto cifrado entre empresas.
 */
export interface SecretOwner {
  tenantId: string;
  integrationId: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** Falha ao decifrar. A mensagem nunca contém o segredo nem o texto cifrado. */
export class SecretDecryptError extends Error {
  constructor(message = 'Não foi possível decifrar o segredo da integração.') {
    super(message);
    this.name = 'SecretDecryptError';
  }
}

function aad(owner: SecretOwner): Buffer {
  return Buffer.from(`${owner.tenantId}:${owner.integrationId}`, 'utf8');
}

export function encryptSecret(masterKey: Buffer, keyVersion: number, owner: SecretOwner, plaintext: string): Buffer {
  if (masterKey.length !== 32) throw new Error('A chave mestra deve ter 32 bytes');
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 255) {
    throw new Error('Versão da chave deve estar entre 1 e 255');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(aad(owner));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([keyVersion]), iv, cipher.getAuthTag(), encrypted]);
}

export function decryptSecret(masterKey: Buffer, owner: SecretOwner, blob: Buffer): string {
  if (!Buffer.isBuffer(blob) || blob.length < HEADER_BYTES) throw new SecretDecryptError();
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, HEADER_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAAD(aad(owner));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(blob.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptError();
  }
}

/** Chave atual e, durante a troca da chave mestra, a anterior com a sua versão. */
export interface MasterKeys {
  current: Buffer;
  previous?: { version: number; key: Buffer } | null;
}

/** Decifra escolhendo a chave pela versão gravada no texto cifrado (anterior ou atual). */
export function decryptWithMasterKeys(keys: MasterKeys, owner: SecretOwner, blob: Buffer): string {
  const previous = keys.previous;
  const key = previous && secretKeyVersion(blob) === previous.version ? previous.key : keys.current;
  return decryptSecret(key, owner, blob);
}

/** Versão da chave gravada no texto cifrado. */
export function secretKeyVersion(blob: Buffer): number | null {
  return Buffer.isBuffer(blob) && blob.length >= HEADER_BYTES ? blob[0]! : null;
}

/** Remove ocorrências do segredo de um texto (mensagens de erro de serviços externos). */
export function scrubSecret(message: string, secret: string | null | undefined): string {
  if (!secret || secret.length < 3) return message;
  return message.split(secret).join('[omitido]');
}
