import { randomBytes } from 'node:crypto';
import type { ImportProfileConfigInput } from '@concilia/core';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { withContext } from '../../src/db/context';
import { runPendingJobs, type RunSummary } from '../../src/jobs/worker';
import type { ApiClient, ApiResponse } from './app';
import { appPool, ownerPool } from './db';

// ---------------------------------------------------------------------------
// Cadastros mínimos, inseridos direto no banco no contexto da empresa (sem depender das rotas da E6)
// ---------------------------------------------------------------------------

export interface TestBankAccount {
  id: string;
  name: string;
  accountNumber: string | null;
}

export async function createBankAccount(
  tenantId: string,
  input: { name?: string; bankCode?: string; branch?: string; accountNumber?: string | null; externalRef?: string } = {},
): Promise<TestBankAccount> {
  const name = input.name ?? `Conta ${randomBytes(3).toString('hex')}`;
  const accountNumber = input.accountNumber === undefined ? '12345-6' : input.accountNumber;
  const result = await withContext(appPool(), { tenantId }, (db) =>
    db.query<{ id: string }>(
      `INSERT INTO bank_accounts (tenant_id, name, bank_code, branch, account_number, external_ref)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, name, input.bankCode ?? '999', input.branch ?? '0001', accountNumber, input.externalRef ?? null],
    ),
  );
  return { id: result.rows[0]!.id, name, accountNumber };
}

export async function createImportProfile(
  tenantId: string,
  input: { name?: string; sourceKind: 'bank' | 'ledger'; fileFormat: 'csv' | 'xlsx'; config: ImportProfileConfigInput },
): Promise<{ id: string; name: string }> {
  const name = input.name ?? `Perfil ${randomBytes(3).toString('hex')}`;
  const result = await withContext(appPool(), { tenantId }, (db) =>
    db.query<{ id: string }>(
      `INSERT INTO import_profiles (tenant_id, name, source_kind, file_format, config)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, name, input.sourceKind, input.fileFormat, JSON.stringify(input.config)],
    ),
  );
  return { id: result.rows[0]!.id, name };
}

// ---------------------------------------------------------------------------
// Arquivos fictícios
// ---------------------------------------------------------------------------

export interface OfxTransactionInput {
  /** Data civil AAAA-MM-DD. */
  date: string;
  /** Valor como aparece no arquivo (ex.: "-35,90", "1500.00"). */
  amount: string;
  memo: string;
  type?: string;
  fitId?: string | null;
  name?: string;
  checkNum?: string;
}

const ofxDate = (date: string) => `${date.replaceAll('-', '')}000000[-3:BRT]`;

/**
 * OFX 1.x (SGML) no estilo de bancos brasileiros: sem tags de fechamento nos campos e em Windows-1252
 * (para letras acentuadas do português, latin1 e Windows-1252 coincidem).
 */
export function buildOfx(input: {
  accountId: string;
  bankId?: string;
  branchId?: string;
  start?: string;
  end?: string;
  transactions: OfxTransactionInput[];
}): Buffer {
  const dates = input.transactions.map((transaction) => transaction.date).sort();
  const start = input.start ?? dates[0] ?? '2024-01-01';
  const end = input.end ?? dates.at(-1) ?? start;
  const body = input.transactions
    .map((transaction, index) =>
      [
        '<STMTTRN>',
        `<TRNTYPE>${transaction.type ?? (transaction.amount.trim().startsWith('-') ? 'DEBIT' : 'CREDIT')}`,
        `<DTPOSTED>${ofxDate(transaction.date)}`,
        `<TRNAMT>${transaction.amount}`,
        ...(transaction.fitId === null ? [] : [`<FITID>${transaction.fitId ?? `FIT${index + 1}`}`]),
        ...(transaction.checkNum ? [`<CHECKNUM>${transaction.checkNum}`] : []),
        ...(transaction.name ? [`<NAME>${transaction.name}`] : []),
        `<MEMO>${transaction.memo}`,
        '</STMTTRN>',
      ].join('\r\n'),
    )
    .join('\r\n');
  const text = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20240131120000[-3:BRT]<LANGUAGE>POR</SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    '<STMTRS>',
    '<CURDEF>BRL',
    `<BANKACCTFROM><BANKID>${input.bankId ?? '0999'}<BRANCHID>${input.branchId ?? '0001'}<ACCTID>${input.accountId}<ACCTTYPE>CHECKING</BANKACCTFROM>`,
    '<BANKTRANLIST>',
    `<DTSTART>${ofxDate(start)}`,
    `<DTEND>${ofxDate(end)}`,
    body,
    '</BANKTRANLIST>',
    `<LEDGERBAL><BALAMT>0.00<DTASOF>${ofxDate(end)}</LEDGERBAL>`,
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1>',
    '</OFX>',
    '',
  ].join('\r\n');
  return Buffer.from(text, 'latin1');
}

/** CSV com `;` e CRLF; Windows-1252 por padrão, como exportam muitos sistemas brasileiros. */
export function buildCsv(
  rows: (string | number)[][],
  options: { delimiter?: string; encoding?: 'utf-8' | 'windows-1252' } = {},
): Buffer {
  const delimiter = options.delimiter ?? ';';
  const text = rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell);
          return value.includes(delimiter) || value.includes('"') ? `"${value.replaceAll('"', '""')}"` : value;
        })
        .join(delimiter),
    )
    .join('\r\n');
  return Buffer.from(`${text}\r\n`, options.encoding === 'utf-8' ? 'utf8' : 'latin1');
}

/** Planilha XLSX gerada com exceljs. Use `new Date(Date.UTC(...))` para datas nativas. */
export async function buildXlsx(rows: (string | number | Date | null)[][], sheetName = 'Planilha1'): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Envio, confirmação e processamento
// ---------------------------------------------------------------------------

export function multipartBody(
  fields: Record<string, string | undefined>,
  upload: { fileName: string; content: Buffer; contentType?: string },
): { body: Buffer; contentType: string } {
  const boundary = `----concilia${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${upload.fileName}"\r\n` +
        `Content-Type: ${upload.contentType ?? 'application/octet-stream'}\r\n\r\n`,
    ),
    upload.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface UploadInput {
  sourceKind: 'bank' | 'ledger';
  bankAccountId?: string;
  profileId?: string;
  fileName: string;
  content: Buffer;
}

/** POST /imports com o arquivo em multipart. */
export function uploadImport(client: ApiClient, input: UploadInput): Promise<ApiResponse> {
  const { body, contentType } = multipartBody(
    { sourceKind: input.sourceKind, bankAccountId: input.bankAccountId, profileId: input.profileId },
    { fileName: input.fileName, content: input.content },
  );
  return client.post('/imports', body, { 'content-type': contentType });
}

/** Drena a fila com as dependências da própria aplicação de teste. */
export function drainJobs(app: FastifyInstance): Promise<RunSummary> {
  return runPendingJobs(app.deps);
}

/** Torna imediatamente prontos os trabalhos em espera de nova tentativa (ignora o intervalo de espera). */
export async function makeJobsDue(jobIds?: string[]): Promise<void> {
  if (jobIds) {
    await ownerPool().query(`UPDATE jobs SET run_at = now() WHERE status = 'queued' AND id = ANY ($1::uuid[])`, [jobIds]);
  } else {
    await ownerPool().query(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);
  }
}

export interface ImportedFile {
  batchId: string;
  jobId: string;
  upload: ApiResponse;
  /** GET /imports/:id depois de drenar a fila. */
  batch: any;
}

/** Envia, confirma, drena a fila e devolve o lote. Falha o teste se o envio ou a confirmação não forem aceitos. */
export async function importFile(
  app: FastifyInstance,
  client: ApiClient,
  input: UploadInput,
  confirm: Record<string, unknown> = {},
): Promise<ImportedFile> {
  const upload = await uploadImport(client, input);
  if (upload.status !== 201) throw new Error(`Envio falhou: ${upload.status} ${JSON.stringify(upload.body)}`);
  const confirmed = await client.post(`/imports/${upload.body.id}/confirm`, confirm);
  if (confirmed.status !== 202) throw new Error(`Confirmação falhou: ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
  await drainJobs(app);
  const batch = await client.get(`/imports/${upload.body.id}`);
  return { batchId: upload.body.id, jobId: confirmed.body.jobId, upload, batch: batch.body };
}

/** Transações de extrato de um lote, vistas pelo dono do esquema (sem RLS), em ordem de linha. */
export async function bankTransactionsOf(batchId: string): Promise<any[]> {
  const result = await ownerPool().query(
    `SELECT id, posted_date::text AS posted_date, amount_cents::int AS amount_cents, description_raw, description_norm,
            external_id, document, identifiers, kind, kind_rule, recon_status, duplicate_suspect, bank_account_id
       FROM bank_transactions WHERE batch_id = $1 ORDER BY row_number`,
    [batchId],
  );
  return result.rows;
}

export async function ledgerEntriesOf(batchId: string): Promise<any[]> {
  const result = await ownerPool().query(
    `SELECT id, entry_date::text AS entry_date, amount_cents::int AS amount_cents, description_raw, external_id,
            document, bank_account_id, content_hash, kind, recon_status
       FROM ledger_entries WHERE batch_id = $1 ORDER BY row_number`,
    [batchId],
  );
  return result.rows;
}
