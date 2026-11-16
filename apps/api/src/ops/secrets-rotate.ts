import pg from 'pg';
import { writeAudit, type AuditActor } from '../audit/audit';
import { decryptSecret, encryptSecret, secretKeyVersion, SecretDecryptError } from '../security/secrets';

/** Falha prevista da troca de chave. A mensagem cita ids de integração, nunca segredo nem texto cifrado. */
export class SecretsRotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsRotationError';
  }
}

export interface RotateSecretsOptions {
  /** Conexão com o papel dono do esquema (MIGRATION_DATABASE_URL): a operação cruza empresas. */
  connectionString: string;
  currentKey: Buffer;
  newKey: Buffer;
  newVersion: number;
  /** Chaves de versões anteriores ainda presentes (ex.: segredo gravado durante a troca anterior). */
  previousKeys?: { version: number; key: Buffer }[];
  log?: (line: string) => void;
}

export interface RotateSecretsResult {
  rotated: number;
  skipped: number;
  tenants: number;
}

const ACTOR: AuditActor = { type: 'system', id: null, label: 'cli secrets:rotate' };

interface IntegrationSecretRow {
  id: string;
  tenant_id: string;
  secret_ciphertext: Buffer;
}

/** Lê uma chave mestra em base64 de 32 bytes. */
export function parseMasterKey(value: string | undefined, variable: string): Buffer {
  const key = value ? Buffer.from(value, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new SecretsRotationError(`${variable} deve ser 32 bytes em base64 (gere com: openssl rand -base64 32).`);
  }
  return key;
}

function tryDecrypt(key: Buffer, row: IntegrationSecretRow): string | null {
  try {
    return decryptSecret(key, { tenantId: row.tenant_id, integrationId: row.id }, row.secret_ciphertext);
  } catch (error) {
    if (error instanceof SecretDecryptError) return null;
    throw error;
  }
}

/**
 * Recifra todos os segredos de `integrations` com a chave nova, em uma única transação.
 * Segredos já na versão nova são pulados (depois de confirmar que decifram com a chave nova).
 * Cada texto novo é decifrado de volta antes da gravação; qualquer falha desfaz tudo.
 */
export async function rotateSecrets(options: RotateSecretsOptions): Promise<RotateSecretsResult> {
  const log = options.log ?? (() => undefined);
  if (options.currentKey.length !== 32 || options.newKey.length !== 32) {
    throw new SecretsRotationError('As chaves mestras devem ter 32 bytes.');
  }
  if (!Number.isInteger(options.newVersion) || options.newVersion < 1 || options.newVersion > 255) {
    throw new SecretsRotationError('NEW_SECRETS_KEY_VERSION deve ser um inteiro entre 1 e 255.');
  }
  // Com a chave anterior informada, a mesma chave é aceita: a passada só recifra o que ficou na versão anterior.
  if (options.currentKey.equals(options.newKey) && (options.previousKeys ?? []).length === 0) {
    throw new SecretsRotationError('A chave nova é igual à atual.');
  }

  const client = new pg.Client({ connectionString: options.connectionString, application_name: 'concilia-cli' });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Trava todos os segredos: gravações concorrentes esperam a troca terminar.
    const found = await client.query<IntegrationSecretRow>(
      `SELECT id, tenant_id, secret_ciphertext FROM integrations
        WHERE secret_ciphertext IS NOT NULL ORDER BY tenant_id, id FOR UPDATE`,
    );
    const unreadable: string[] = [];
    const notNewKey: string[] = [];
    const updates: { row: IntegrationSecretRow; blob: Buffer }[] = [];
    let skipped = 0;
    for (const row of found.rows) {
      if (secretKeyVersion(row.secret_ciphertext) === options.newVersion) {
        if (tryDecrypt(options.newKey, row) === null) notNewKey.push(row.id);
        else skipped += 1;
        continue;
      }
      // A versão gravada no texto escolhe a chave; sem chave anterior daquela versão, usa a atual.
      const version = secretKeyVersion(row.secret_ciphertext);
      const previous = options.previousKeys?.find((item) => item.version === version);
      const plaintext = tryDecrypt(previous?.key ?? options.currentKey, row);
      if (plaintext === null) {
        unreadable.push(row.id);
        continue;
      }
      const owner = { tenantId: row.tenant_id, integrationId: row.id };
      const blob = encryptSecret(options.newKey, options.newVersion, owner, plaintext);
      if (decryptSecret(options.newKey, owner, blob) !== plaintext) {
        throw new SecretsRotationError(`Verificação da recifra falhou na integração ${row.id}.`);
      }
      updates.push({ row, blob });
    }
    const problems: string[] = [];
    if (notNewKey.length > 0) {
      problems.push(
        `${notNewKey.length} segredo(s) já marcado(s) com a versão ${options.newVersion} não decifra(m) com a chave nova: ${notNewKey.join(', ')}`,
      );
    }
    if (unreadable.length > 0) {
      problems.push(
        `${unreadable.length} segredo(s) não puderam ser decifrados com a chave atual: ${unreadable.join(', ')}`,
      );
    }
    if (problems.length > 0) {
      throw new SecretsRotationError(`Troca da chave cancelada; nada foi alterado. ${problems.join('. ')}.`);
    }

    const perTenant = new Map<string, number>();
    for (const { row, blob } of updates) {
      await client.query(
        'UPDATE integrations SET secret_ciphertext = $3, secret_key_version = $4 WHERE tenant_id = $1 AND id = $2',
        [row.tenant_id, row.id, blob, options.newVersion],
      );
      perTenant.set(row.tenant_id, (perTenant.get(row.tenant_id) ?? 0) + 1);
    }
    for (const [tenantId, count] of perTenant) {
      await writeAudit(client, {
        tenantId,
        actor: ACTOR,
        action: 'integration.secrets_rotated',
        entityType: 'integration',
        entityId: null,
        summary: `${count} segredo(s) de integração recifrado(s) com a chave mestra versão ${options.newVersion}`,
        metadata: { count, toVersion: options.newVersion },
      });
    }
    if (updates.length > 0) {
      await writeAudit(client, {
        tenantId: null,
        actor: ACTOR,
        action: 'platform.secrets_rotated',
        entityType: 'integration',
        entityId: null,
        summary: `Chave mestra trocada para a versão ${options.newVersion}: ${updates.length} segredo(s) em ${perTenant.size} empresa(s)`,
        metadata: { count: updates.length, tenants: perTenant.size, skipped, toVersion: options.newVersion },
      });
    }
    await client.query('COMMIT');
    log(
      `Troca da chave mestra concluída: ${updates.length} recifrado(s), ${skipped} já na versão ${options.newVersion}, ` +
        `${perTenant.size} empresa(s) afetada(s).`,
    );
    return { rotated: updates.length, skipped, tenants: perTenant.size };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
