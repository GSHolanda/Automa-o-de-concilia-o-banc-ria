import { describe, expect, it } from 'vitest';
import { assertServerConfig, ConfigError, loadConfig } from '../../src/config/env';

const base = {
  DATABASE_URL: 'postgres://app@localhost/concilia',
  SESSION_SECRET: 'segredo-de-sessao-apenas-para-testes-0123456789',
  SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const production = { ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true', PASSWORD_SCRYPT_COST: '17' };

describe('TRUST_PROXY (achado 5)', () => {
  it('aceita ausente, false, número de saltos e lista de redes', () => {
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1,loopback' }).trustProxy).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
      'loopback',
    ]);
  });

  it('recusa true (confiaria em qualquer salto e permitiria forjar o IP) e valores inválidos', () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/99' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'proxy.exemplo.test' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TRUST_PROXY: '0' })).toThrow(ConfigError);
  });
});

describe('exigências do servidor HTTP em produção (achados 5 e 14)', () => {
  it('fora de produção, nada é exigido', () => {
    expect(() => assertServerConfig(loadConfig(base))).not.toThrow();
  });

  it('em produção, TRUST_PROXY precisa ser definido de propósito', () => {
    expect(() => assertServerConfig(loadConfig({ ...production, METRICS_TOKEN: 'token-de-metricas-ficticio' }))).toThrow(/TRUST_PROXY/);
    expect(() =>
      assertServerConfig(loadConfig({ ...production, METRICS_TOKEN: 'token-de-metricas-ficticio', TRUST_PROXY: 'false' })),
    ).not.toThrow();
  });

  it('em produção, /metrics exige METRICS_TOKEN', () => {
    expect(() => assertServerConfig(loadConfig({ ...production, TRUST_PROXY: '1' }))).toThrow(/METRICS_TOKEN/);
    expect(() => assertServerConfig(loadConfig({ ...production, TRUST_PROXY: '1', METRICS_TOKEN: 'curto' }))).toThrow(/METRICS_TOKEN/);
    expect(() =>
      assertServerConfig(loadConfig({ ...production, TRUST_PROXY: '1', METRICS_TOKEN: 'token-de-metricas-ficticio' })),
    ).not.toThrow();
  });
});
