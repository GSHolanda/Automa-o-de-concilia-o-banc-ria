import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Configuração da implantação, lida de variáveis de ambiente e validada na inicialização.
 * Configuração de cada empresa não fica aqui: fica no banco (tenant_settings e cadastros).
 */

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value, context) => {
      if (value === undefined || value === '') return fallback;
      if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) return true;
      if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) return false;
      context.addIssue({ code: 'custom', message: 'use true ou false' });
      return z.NEVER;
    });

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value, context) => {
      if (value === undefined || value === '') return fallback;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        context.addIssue({ code: 'custom', message: `use um inteiro entre ${min} e ${max}` });
        return z.NEVER;
      }
      return parsed;
    });

/** Palavras-chave de redes aceitas pelo Fastify (proxy-addr). */
const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isNetwork(value: string): boolean {
  if (PROXY_KEYWORDS.has(value)) return true;
  const [address, prefix, extra] = value.split('/');
  const family = isIP(address ?? '');
  if (family === 0 || extra !== undefined) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return /^\d+$/.test(prefix) && bits <= (family === 4 ? 32 : 128);
}

/**
 * Proxies confiáveis à frente da API: `false` (nenhum), número de saltos (1 a 10) ou lista de redes.
 * `true` confiaria em qualquer salto e permitiria forjar o IP pelo X-Forwarded-For: é recusado.
 */
const trustProxy = z
  .string()
  .optional()
  .transform((value, context): false | number | string[] => {
    const text = value?.trim() ?? '';
    if (text === '' || text.toLowerCase() === 'false') return false;
    if (/^\d+$/.test(text)) {
      const hops = Number(text);
      if (hops >= 1 && hops <= 10) return hops;
    } else if (text.toLowerCase() !== 'true') {
      const networks = text.split(',').map((item) => item.trim()).filter(Boolean);
      if (networks.length > 0 && networks.every(isNetwork)) return networks;
    }
    context.addIssue({
      code: 'custom',
      message: 'use false, o número de proxies à frente da API (1 a 10) ou a lista de redes dos proxies (ex.: 10.0.0.0/8,127.0.0.1)',
    });
    return z.NEVER;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(3000, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PRODUCT_NAME: z.string().min(1).max(60).default('Concilia'),
  DEPLOYMENT_MODE: z.enum(['multi', 'single']).default('multi'),

  DATABASE_URL: z.string().min(1, 'defina DATABASE_URL com o papel da aplicação'),
  MIGRATION_DATABASE_URL: z.string().optional(),
  DB_APP_ROLE: z.string().default('concilia_app'),
  DB_POOL_MAX: int(10, 1, 100),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET deve ter ao menos 32 caracteres'),
  SECRETS_MASTER_KEY: z.string().refine((value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'SECRETS_MASTER_KEY deve ser 32 bytes em base64 (gere com: openssl rand -base64 32)'),
  SECRETS_KEY_VERSION: int(1, 1, 255),
  /** Chave anterior, só durante a troca da chave mestra: segredos gravados com ela continuam legíveis. */
  SECRETS_PREVIOUS_MASTER_KEY: z
    .string()
    .optional()
    .refine((value) => !value || Buffer.from(value, 'base64').length === 32, 'SECRETS_PREVIOUS_MASTER_KEY deve ser 32 bytes em base64'),
  SECRETS_PREVIOUS_KEY_VERSION: z
    .string()
    .optional()
    .refine((value) => !value || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 255), 'use um inteiro entre 1 e 255'),
  COOKIE_SECURE: bool(true),
  SESSION_ABSOLUTE_HOURS: int(12, 1, 720),
  LOGIN_MAX_ATTEMPTS: int(5, 3, 20),
  LOGIN_LOCK_MINUTES: int(15, 1, 1440),
  /** log2 do custo N do scrypt. 17 segue a recomendação da OWASP; valores menores só em testes. */
  PASSWORD_SCRYPT_COST: int(17, 10, 20),
  RATE_LIMIT_ENABLED: bool(true),
  TRUST_PROXY: trustProxy,

  WORKER_ENABLED: bool(true),
  WORKER_POLL_MS: int(1000, 100, 60_000),
  WORKER_CONCURRENCY: int(2, 1, 16),
  JOB_TIMEOUT_SECONDS: int(600, 30, 86_400),

  MAX_UPLOAD_MB: int(15, 1, 100),
  MAX_IMPORT_ROWS: int(100_000, 100, 500_000),
  /** Permite integrações com endereços privados. Apenas para desenvolvimento e testes. */
  ALLOW_PRIVATE_INTEGRATION_HOSTS: bool(false),
  METRICS_TOKEN: z.string().optional(),
  WEB_DIST_DIR: z.string().optional(),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  productName: string;
  deploymentMode: 'multi' | 'single';
  databaseUrl: string;
  migrationDatabaseUrl: string | null;
  dbAppRole: string;
  dbPoolMax: number;
  sessionSecret: string;
  secretsMasterKey: Buffer;
  secretsKeyVersion: number;
  secretsPreviousKey: { version: number; key: Buffer } | null;
  cookieSecure: boolean;
  sessionAbsoluteHours: number;
  loginMaxAttempts: number;
  loginLockMinutes: number;
  passwordScryptCost: number;
  rateLimitEnabled: boolean;
  trustProxy: false | number | string[];
  /** TRUST_PROXY foi definido de propósito (exigido em produção). */
  trustProxyDefined: boolean;
  workerEnabled: boolean;
  workerPollMs: number;
  workerConcurrency: number;
  jobTimeoutSeconds: number;
  maxUploadBytes: number;
  maxImportRows: number;
  allowPrivateIntegrationHosts: boolean;
  metricsToken: string | null;
  webDistDir: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new ConfigError(`Configuração inválida:\n${problems}`);
  }
  const value = parsed.data;
  if (value.NODE_ENV === 'production') {
    if (!value.COOKIE_SECURE) throw new ConfigError('Em produção, COOKIE_SECURE deve ser true (HTTPS obrigatório).');
    if (value.ALLOW_PRIVATE_INTEGRATION_HOSTS) {
      throw new ConfigError('ALLOW_PRIVATE_INTEGRATION_HOSTS não pode ser usado em produção.');
    }
    if (value.PASSWORD_SCRYPT_COST < 15) throw new ConfigError('Em produção, PASSWORD_SCRYPT_COST deve ser 15 ou mais.');
  }
  let secretsPreviousKey: Config['secretsPreviousKey'] = null;
  if (value.SECRETS_PREVIOUS_MASTER_KEY) {
    const version = Number(value.SECRETS_PREVIOUS_KEY_VERSION);
    if (!value.SECRETS_PREVIOUS_KEY_VERSION || version === value.SECRETS_KEY_VERSION) {
      throw new ConfigError(
        'Com SECRETS_PREVIOUS_MASTER_KEY, defina SECRETS_PREVIOUS_KEY_VERSION com a versão da chave anterior (diferente de SECRETS_KEY_VERSION).',
      );
    }
    secretsPreviousKey = { version, key: Buffer.from(value.SECRETS_PREVIOUS_MASTER_KEY, 'base64') };
  }
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    productName: value.PRODUCT_NAME,
    deploymentMode: value.DEPLOYMENT_MODE,
    databaseUrl: value.DATABASE_URL,
    migrationDatabaseUrl: value.MIGRATION_DATABASE_URL || null,
    dbAppRole: value.DB_APP_ROLE,
    dbPoolMax: value.DB_POOL_MAX,
    sessionSecret: value.SESSION_SECRET,
    secretsMasterKey: Buffer.from(value.SECRETS_MASTER_KEY, 'base64'),
    secretsKeyVersion: value.SECRETS_KEY_VERSION,
    secretsPreviousKey,
    cookieSecure: value.COOKIE_SECURE,
    sessionAbsoluteHours: value.SESSION_ABSOLUTE_HOURS,
    loginMaxAttempts: value.LOGIN_MAX_ATTEMPTS,
    loginLockMinutes: value.LOGIN_LOCK_MINUTES,
    passwordScryptCost: value.PASSWORD_SCRYPT_COST,
    rateLimitEnabled: value.RATE_LIMIT_ENABLED,
    trustProxy: value.TRUST_PROXY,
    trustProxyDefined: (env.TRUST_PROXY ?? '').trim() !== '',
    workerEnabled: value.WORKER_ENABLED,
    workerPollMs: value.WORKER_POLL_MS,
    workerConcurrency: value.WORKER_CONCURRENCY,
    jobTimeoutSeconds: value.JOB_TIMEOUT_SECONDS,
    maxUploadBytes: value.MAX_UPLOAD_MB * 1024 * 1024,
    maxImportRows: value.MAX_IMPORT_ROWS,
    allowPrivateIntegrationHosts: value.ALLOW_PRIVATE_INTEGRATION_HOSTS,
    metricsToken: value.METRICS_TOKEN || null,
    webDistDir: value.WEB_DIST_DIR || null,
  };
}

/** Tamanho mínimo do token de métricas em produção. */
const METRICS_TOKEN_MIN_LENGTH = 16;

/**
 * Exigências do servidor HTTP em produção (não valem para a CLI nem para o trabalhador avulso):
 * proxy definido de propósito, para o limite por IP e a trilha usarem o endereço certo, e /metrics com token.
 */
export function assertServerConfig(config: Config): void {
  if (config.nodeEnv !== 'production') return;
  if (!config.trustProxyDefined) {
    throw new ConfigError(
      'Em produção, defina TRUST_PROXY: número de proxies à frente da API (ex.: 1), lista de redes dos proxies, ou false se não há proxy.',
    );
  }
  if (!config.metricsToken || config.metricsToken.length < METRICS_TOKEN_MIN_LENGTH) {
    throw new ConfigError(
      `Em produção, defina METRICS_TOKEN com ao menos ${METRICS_TOKEN_MIN_LENGTH} caracteres (gere com: openssl rand -hex 32).`,
    );
  }
}
