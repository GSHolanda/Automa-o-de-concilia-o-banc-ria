import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asTenant, closePools, insertRawBankTransaction, insertRawTenant, ownerPool, type RawTenant } from '../helpers/db';

let a: RawTenant;
let b: RawTenant;

const insertAudit = (tenant: RawTenant, action: string) =>
  asTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO audit_log (tenant_id, actor_type, actor_id, actor_label, action, entity_type, entity_id, summary, after, seq, hash)
       VALUES ($1, 'user', $2, 'Pessoa Teste', $3, 'teste', 'x', 'evento de teste', '{"k": 1}', 0, '\\x00')
       RETURNING seq, encode(prev_hash, 'hex') AS prev, encode(hash, 'hex') AS hash`,
      [tenant.id, tenant.userId, action],
    ),
  );

beforeAll(async () => {
  a = await insertRawTenant('audita');
  b = await insertRawTenant('auditb');
});

afterAll(closePools);

describe('trilha de auditoria', () => {
  it('numera e encadeia os registros por empresa, ignorando seq e hash enviados pelo cliente', async () => {
    const first = (await insertAudit(a, 'teste.um')).rows[0];
    const other = (await insertAudit(b, 'teste.outra-empresa')).rows[0];
    const second = (await insertAudit(a, 'teste.dois')).rows[0];

    expect(first.seq).toBe('1');
    expect(first.prev).toBeNull();
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.seq).toBe('2');
    expect(second.prev).toBe(first.hash);
    expect(other.seq).toBe('1');
  });

  it('o papel da aplicação não tem privilégio para alterar nem apagar', async () => {
    await expect(asTenant(a.id, (db) => db.query(`UPDATE audit_log SET summary = 'x'`))).rejects.toThrow(
      /permission denied/i,
    );
    await expect(asTenant(a.id, (db) => db.query(`DELETE FROM audit_log`))).rejects.toThrow(/permission denied/i);
  });

  it('mesmo o dono do esquema é barrado pelo gatilho', async () => {
    await expect(ownerPool().query(`UPDATE audit_log SET summary = 'x' WHERE tenant_id = $1`, [a.id])).rejects.toThrow(
      /não pode ser alterada/,
    );
    await expect(ownerPool().query(`DELETE FROM audit_log WHERE tenant_id = $1`, [a.id])).rejects.toThrow(
      /não pode ser alterada/,
    );
    await expect(ownerPool().query(`TRUNCATE audit_log`)).rejects.toThrow(/não pode ser alterada/);
  });

  it('a verificação confirma a cadeia íntegra e informa o último hash', async () => {
    const result = await asTenant(a.id, (db) => db.query('SELECT * FROM audit_verify_chain($1)', [a.id]));
    expect(result.rows[0]).toMatchObject({ checked: '2', broken_seq: null, head_seq: '2' });
    expect(result.rows[0].head_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a verificação aponta o registro adulterado por quem contornou os gatilhos', async () => {
    const tenant = await insertRawTenant('adulterada');
    await insertAudit(tenant, 'teste.um');
    await insertAudit(tenant, 'teste.dois');
    await insertAudit(tenant, 'teste.tres');

    const client = await ownerPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change');
      await client.query(`UPDATE audit_log SET summary = 'conteúdo trocado' WHERE tenant_id = $1 AND seq = 2`, [
        tenant.id,
      ]);
      await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_change');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const result = await asTenant(tenant.id, (db) => db.query('SELECT * FROM audit_verify_chain($1)', [tenant.id]));
    expect(result.rows[0]).toMatchObject({ checked: '1', broken_seq: '2' });
  });

  it('uma empresa não verifica nem lê a trilha de outra', async () => {
    const result = await asTenant(a.id, (db) => db.query('SELECT * FROM audit_verify_chain($1)', [b.id]));
    expect(result.rows[0]).toMatchObject({ checked: '0', broken_seq: null });
  });
});

describe('imutabilidade dos registros de origem', () => {
  it.each([
    ['amount_cents', '999'],
    ['posted_date', `'2030-01-01'`],
    ['description_raw', `'outra descrição'`],
    ['external_id', `'outro'`],
    ['raw', `'{"x": 1}'`],
    ['dedup_key', `'outra'`],
  ])('rejeita alteração da coluna de origem %s', async (column, value) => {
    const id = await insertRawBankTransaction(a);
    await expect(
      asTenant(a.id, (db) => db.query(`UPDATE bank_transactions SET ${column} = ${value} WHERE id = $1`, [id])),
    ).rejects.toThrow(/imutáveis/);
  });

  it('permite alterar o estado derivado', async () => {
    const id = await insertRawBankTransaction(a);
    const result = await asTenant(a.id, (db) =>
      db.query(
        `UPDATE bank_transactions SET recon_status = 'reconciled', kind = 'fee', duplicate_suspect = true WHERE id = $1`,
        [id],
      ),
    );
    expect(result.rowCount).toBe(1);
  });

  it('não permite apagar: sem privilégio para a aplicação e barrado por gatilho para o dono', async () => {
    const id = await insertRawBankTransaction(a);
    await expect(
      asTenant(a.id, (db) => db.query('DELETE FROM bank_transactions WHERE id = $1', [id])),
    ).rejects.toThrow(/permission denied/i);
    await expect(ownerPool().query('DELETE FROM bank_transactions WHERE id = $1', [id])).rejects.toThrow(
      /não podem ser apagados/,
    );
  });

  it('aplica a mesma proteção aos lançamentos do sistema financeiro', async () => {
    const batch = await ownerPool().query<{ id: string }>(
      `INSERT INTO import_batches (tenant_id, source_kind, file_name, file_format, file_sha256, status)
       VALUES ($1, 'ledger', 'l.csv', 'csv', gen_random_uuid()::text, 'completed') RETURNING id`,
      [a.id],
    );
    const entry = await ownerPool().query<{ id: string }>(
      `INSERT INTO ledger_entries (tenant_id, batch_id, row_number, entry_date, amount_cents, description_raw,
                                   description_norm, dedup_key, content_hash)
       VALUES ($1, $2, 1, '2024-01-05', 5000, 'Venda', 'VENDA', gen_random_uuid()::text, 'h') RETURNING id`,
      [a.id, batch.rows[0]!.id],
    );
    await expect(
      asTenant(a.id, (db) => db.query('UPDATE ledger_entries SET amount_cents = 1 WHERE id = $1', [entry.rows[0]!.id])),
    ).rejects.toThrow(/imutáveis/);
    const ok = await asTenant(a.id, (db) =>
      db.query(`UPDATE ledger_entries SET recon_status = 'ignored' WHERE id = $1`, [entry.rows[0]!.id]),
    );
    expect(ok.rowCount).toBe(1);
  });
});
