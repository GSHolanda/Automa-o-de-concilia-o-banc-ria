import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, scrubSecret, SecretDecryptError } from '../../src/security/secrets';

const key = randomBytes(32);

describe('cofre de segredos (CA-23)', () => {
  const owner = { tenantId: randomUUID(), integrationId: randomUUID() };

  it('cifra e decifra no mesmo contexto; formato versão|iv|tag|cifra', () => {
    const blob = encryptSecret(key, 3, owner, 'segredo-ficticio-123');
    expect(blob[0]).toBe(3);
    expect(blob.length).toBe(1 + 12 + 16 + Buffer.byteLength('segredo-ficticio-123'));
    expect(blob.includes(Buffer.from('segredo-ficticio-123'))).toBe(false);
    expect(decryptSecret(key, owner, blob)).toBe('segredo-ficticio-123');
  });

  it('o mesmo segredo gera textos cifrados diferentes (iv aleatório)', () => {
    const a = encryptSecret(key, 1, owner, 'x');
    const b = encryptSecret(key, 1, owner, 'x');
    expect(a.equals(b)).toBe(false);
  });

  it('texto cifrado de uma empresa não decifra no contexto de outra nem de outra integração', () => {
    const blob = encryptSecret(key, 1, owner, 'segredo-da-empresa-a');
    expect(() => decryptSecret(key, { ...owner, tenantId: randomUUID() }, blob)).toThrow(SecretDecryptError);
    expect(() => decryptSecret(key, { ...owner, integrationId: randomUUID() }, blob)).toThrow(SecretDecryptError);
    expect(() => decryptSecret(randomBytes(32), owner, blob)).toThrow(SecretDecryptError);
  });

  it('texto adulterado é recusado e a mensagem de erro não contém o segredo', () => {
    const blob = encryptSecret(key, 1, owner, 'segredo-adulterado');
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    try {
      decryptSecret(key, owner, blob);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SecretDecryptError);
      expect(String(error)).not.toContain('segredo-adulterado');
    }
    expect(() => decryptSecret(key, owner, Buffer.alloc(10))).toThrow(SecretDecryptError);
  });

  it('scrubSecret remove o segredo de mensagens de erro', () => {
    expect(scrubSecret('falhou com chave abc123 e abc123', 'abc123')).toBe('falhou com chave [omitido] e [omitido]');
    expect(scrubSecret('nada aqui', null)).toBe('nada aqui');
  });
});
