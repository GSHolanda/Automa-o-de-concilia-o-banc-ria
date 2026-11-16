import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env';
import { readSecret, type IntegrationRow } from '../../src/modules/integrations/store';
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

describe('chave anterior durante a troca da chave mestra (achado 10)', () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const env = {
    DATABASE_URL: 'postgres://app@localhost/concilia',
    SESSION_SECRET: 'segredo-de-sessao-apenas-para-testes-0123456789',
    SECRETS_MASTER_KEY: newKey.toString('base64'),
    SECRETS_KEY_VERSION: '2',
  };
  const row = (blob: Buffer): IntegrationRow => {
    const now = new Date();
    return {
      id: owner.integrationId,
      tenant_id: owner.tenantId,
      kind: 'webhook',
      name: 'Gancho',
      config: {},
      secret_ciphertext: blob,
      secret_key_version: blob[0]!,
      status: 'configured',
      last_checked_at: null,
      last_error: null,
      active: true,
      created_by: null,
      created_at: now,
      updated_at: now,
    };
  };
  const owner = { tenantId: randomUUID(), integrationId: randomUUID() };

  it('decifra pela versão gravada no texto: anterior com a chave anterior, atual com a atual', () => {
    const config = loadConfig({ ...env, SECRETS_PREVIOUS_MASTER_KEY: oldKey.toString('base64'), SECRETS_PREVIOUS_KEY_VERSION: '1' });
    expect(readSecret(config, row(encryptSecret(oldKey, 1, owner, 'segredo-antigo')))).toBe('segredo-antigo');
    expect(readSecret(config, row(encryptSecret(newKey, 2, owner, 'segredo-novo')))).toBe('segredo-novo');
  });

  it('sem a chave anterior, o texto da versão antiga não decifra', () => {
    expect(() => readSecret(loadConfig(env), row(encryptSecret(oldKey, 1, owner, 'segredo-antigo')))).toThrow(SecretDecryptError);
  });

  it('chave anterior exige versão própria, diferente da atual', () => {
    expect(() => loadConfig({ ...env, SECRETS_PREVIOUS_MASTER_KEY: oldKey.toString('base64') })).toThrow(/SECRETS_PREVIOUS_KEY_VERSION/);
    expect(() =>
      loadConfig({ ...env, SECRETS_PREVIOUS_MASTER_KEY: oldKey.toString('base64'), SECRETS_PREVIOUS_KEY_VERSION: '2' }),
    ).toThrow(/SECRETS_PREVIOUS_KEY_VERSION/);
  });
});
