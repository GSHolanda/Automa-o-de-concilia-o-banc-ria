import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rotateSecrets, SecretsRotationError } from '../../src/ops/secrets-rotate';
import { decryptSecret, encryptSecret, secretKeyVersion } from '../../src/security/secrets';
import { closePools } from '../helpers/db';
import { createIsolatedDatabase, insertTenantRow, type IsolatedDatabase } from '../helpers/isolated-db';

const OLD_KEY = randomBytes(32);
const NEW_KEY = randomBytes(32);

let db: IsolatedDatabase;
let a: { id: string };
let b: { id: string };
const plaintexts = new Map<string, string>();

async function insertIntegration(tenantId: string, name: string, secret: string | null, key = OLD_KEY, version = 1) {
  const id = randomUUID();
  const blob = secret === null ? null : encryptSecret(key, version, { tenantId, integrationId: id }, secret);
  await db.pool.query(
    `INSERT INTO integrations (id, tenant_id, kind, name, config, secret_ciphertext, secret_key_version, status)
     VALUES ($1, $2, 'webhook', $3, '{"url": "http://127.0.0.1:9/x"}', $4, $5, 'configured')`,
    [id, tenantId, name, blob, secret === null ? null : version],
  );
  if (secret !== null) plaintexts.set(id, secret);
  return id;
}

async function rows() {
  const result = await db.pool.query<{
    id: string;
    tenant_id: string;
    secret_ciphertext: Buffer | null;
    secret_key_version: number | null;
  }>('SELECT id, tenant_id, secret_ciphertext, secret_key_version FROM integrations ORDER BY id');
  return result.rows;
}

const rotate = (overrides: Partial<Parameters<typeof rotateSecrets>[0]> = {}, lines: string[] = []) =>
  rotateSecrets({
    connectionString: db.url,
    currentKey: OLD_KEY,
    newKey: NEW_KEY,
    newVersion: 2,
    log: (line) => lines.push(line),
    ...overrides,
  });

beforeAll(async () => {
  db = await createIsolatedDatabase();
  a = await insertTenantRow(db.pool, 'rotacaoa');
  b = await insertTenantRow(db.pool, 'rotacaob');
  await insertIntegration(a.id, 'Gancho A1', `segredo-ficticio-a1-${randomBytes(4).toString('hex')}`);
  await insertIntegration(a.id, 'Gancho A2', `segredo-ficticio-a2-${randomBytes(4).toString('hex')}`);
  await insertIntegration(a.id, 'Sem segredo', null);
  await insertIntegration(b.id, 'Gancho B1', `segredo-ficticio-b1-${randomBytes(4).toString('hex')}`);
});

afterAll(async () => {
  await db.drop();
  await closePools();
});

describe('secrets:rotate', () => {
  it('chave atual errada: falha sem alterar nada e sem imprimir segredo', async () => {
    const before = await rows();
    const lines: string[] = [];
    const error = await rotate({ currentKey: randomBytes(32) }, lines).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretsRotationError);
    expect((error as Error).message).toMatch(/3 segredo/);
    expect(await rows()).toEqual(before);
    const output = `${lines.join('\n')}\n${(error as Error).message}`;
    for (const secret of plaintexts.values()) expect(output).not.toContain(secret);
  });

  it('recusa versão nova fora do intervalo do formato', async () => {
    await expect(rotate({ newVersion: 256 })).rejects.toThrow(/entre 1 e 255/);
    await expect(rotate({ newKey: randomBytes(16) })).rejects.toThrow(/32 bytes/);
  });

  it('recifra todos os segredos com a chave nova, grava a versão e audita por empresa', async () => {
    const lines: string[] = [];
    const result = await rotate({}, lines);
    expect(result).toMatchObject({ rotated: 3, skipped: 0, tenants: 2 });

    for (const row of await rows()) {
      if (row.secret_ciphertext === null) {
        expect(row.secret_key_version).toBeNull();
        continue;
      }
      const owner = { tenantId: row.tenant_id, integrationId: row.id };
      expect(row.secret_key_version).toBe(2);
      expect(secretKeyVersion(row.secret_ciphertext)).toBe(2);
      expect(decryptSecret(NEW_KEY, owner, row.secret_ciphertext)).toBe(plaintexts.get(row.id));
      expect(() => decryptSecret(OLD_KEY, owner, row.secret_ciphertext as Buffer)).toThrow();
    }
    const output = lines.join('\n');
    expect(output).toMatch(/3 recifrado/);
    for (const secret of plaintexts.values()) expect(output).not.toContain(secret);

    const audit = await db.pool.query(
      `SELECT tenant_id, action, metadata FROM audit_log WHERE action LIKE '%secrets_rotated' ORDER BY id`,
    );
    const byTenant = audit.rows.filter((row) => row.tenant_id !== null);
    expect(byTenant).toHaveLength(2);
    expect(byTenant.find((row) => row.tenant_id === a.id)?.metadata).toMatchObject({ count: 2, toVersion: 2 });
    expect(audit.rows.filter((row) => row.tenant_id === null)).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toMatch(/segredo-ficticio/);
    const chain = await db.pool.query('SELECT broken_seq FROM audit_verify_chain($1)', [a.id]);
    expect(chain.rows[0].broken_seq).toBeNull();
  });

  it('é idempotente: segredos já na versão nova são pulados', async () => {
    const before = await rows();
    const result = await rotate();
    expect(result).toMatchObject({ rotated: 0, skipped: 3 });
    expect(await rows()).toEqual(before);
  });

  it('recusa nova chave que não decifra segredos já marcados com a versão nova', async () => {
    const before = await rows();
    await expect(rotate({ newKey: randomBytes(32) })).rejects.toThrow(/não decifra/);
    expect(await rows()).toEqual(before);
  });

  it('um segredo ilegível interrompe tudo: nenhum outro é recifrado', async () => {
    const third = randomBytes(32);
    const broken = await insertIntegration(b.id, 'Corrompido', 'segredo-ficticio-corrompido', randomBytes(32), 2);
    const pending = await insertIntegration(b.id, 'Pendente', 'segredo-ficticio-pendente', OLD_KEY, 1);
    const before = await rows();
    const error = await rotate({ currentKey: NEW_KEY, newKey: third, newVersion: 3 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretsRotationError);
    expect((error as Error).message).toContain(broken);
    expect((error as Error).message).toContain(pending);
    expect(await rows()).toEqual(before);
  });

  it('achado 10: segredo gravado com a chave anterior durante a troca é recifrado quando a chave anterior é informada', async () => {
    await db.pool.query(`DELETE FROM integrations WHERE name = 'Corrompido'`);
    const third = randomBytes(32);
    // Sem a chave anterior, o segredo "Pendente" (versão 1, gravado na janela da troca) trava a troca.
    await expect(rotate({ currentKey: NEW_KEY, newKey: third, newVersion: 3 })).rejects.toThrow(/não puderam ser decifrados/);
    const result = await rotate({ currentKey: NEW_KEY, newKey: third, newVersion: 3, previousKeys: [{ version: 1, key: OLD_KEY }] });
    expect(result.rotated).toBeGreaterThan(0);
    for (const row of await rows()) {
      if (!row.secret_ciphertext) continue;
      expect(secretKeyVersion(row.secret_ciphertext)).toBe(3);
      const plaintext = decryptSecret(third, { tenantId: row.tenant_id, integrationId: row.id }, row.secret_ciphertext);
      expect(plaintext).toBe(plaintexts.get(row.id));
    }
    // Depois de reiniciar com a chave nova e a anterior, uma segunda passada recifra o que sobrou da janela.
    const leftover = await insertIntegration(a.id, 'Gravado na janela', 'segredo-ficticio-janela', NEW_KEY, 2);
    await expect(rotate({ currentKey: third, newKey: third, newVersion: 3 })).rejects.toThrow(/igual/);
    const second = await rotate({ currentKey: third, newKey: third, newVersion: 3, previousKeys: [{ version: 2, key: NEW_KEY }] });
    expect(second.rotated).toBe(1);
    const stored = (await rows()).find((row) => row.id === leftover)!;
    expect(decryptSecret(third, { tenantId: a.id, integrationId: leftover }, stored.secret_ciphertext!)).toBe('segredo-ficticio-janela');
  });
});
