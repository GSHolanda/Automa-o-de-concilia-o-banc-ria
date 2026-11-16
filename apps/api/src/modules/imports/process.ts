import {
  classify,
  computeDedupKeys,
  contentHash,
  extractReferences,
  ImportConfigError,
  importProfileConfigSchema,
  ledgerEntryInputV1Schema,
  mapTabular,
  normalizeDescription,
  normalizeIdentifier,
  type ClassificationRule,
} from '@concilia/core';
import type { Db } from '../../db/context';
import type { JobContext, JobHandler, JobRecord } from '../../jobs/types';
import { emitNotification } from '../notifications/service';
import { loadEntitlements } from '../tenancy/entitlements';
import {
  ImportContentError,
  ofxDescription,
  pickStatement,
  readOfx,
  readTabular,
  tabularOptions,
} from './files';
import {
  findBankAccount,
  findBatch,
  loadBatchFile,
  type BankAccountRow,
  type BatchRow,
  type ImportStats,
} from './queries';

/** Registro de origem já lido do arquivo, comum a OFX, CSV e XLSX. */
interface SourceRecord {
  rowNumber: number;
  date: string;
  amountCents: number;
  description: string;
  externalId: string | null;
  document: string | null;
  reference: string | null;
  counterparty: string | null;
  dueDate: string | null;
  bankAccountRef: string | null;
  costCenter: string | null;
  category: string | null;
  bankType: string | null;
  raw: Record<string, string>;
}

interface Rejection {
  rowNumber: number;
  kind: 'invalid' | 'conflict';
  reason: string;
  raw: Record<string, unknown>;
}

interface ParsedFile {
  records: SourceRecord[];
  rejections: Rejection[];
  skipped: number;
  periodStart: string | null;
  periodEnd: string | null;
}

interface Counts {
  imported: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  duplicateSuspects: number;
  rejections: Rejection[];
}

const CHUNK = 1_000;

function emptyStats(): ImportStats {
  return {
    totalRows: 0,
    imported: 0,
    duplicates: 0,
    rejected: 0,
    conflicts: 0,
    skipped: 0,
    duplicateSuspects: 0,
    periodStart: null,
    periodEnd: null,
  };
}

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function dateRange(records: readonly SourceRecord[]): { start: string | null; end: string | null } {
  let start: string | null = null;
  let end: string | null = null;
  for (const record of records) {
    if (start === null || record.date < start) start = record.date;
    if (end === null || record.date > end) end = record.date;
  }
  return { start, end };
}

/** Identificadores comparáveis: documento, referência e referências reconhecidas na descrição. */
function identifiersOf(record: SourceRecord): string[] {
  const found = new Set<string>();
  for (const value of [record.document, record.reference]) {
    const normalized = normalizeIdentifier(value);
    if (normalized) found.add(normalized);
  }
  for (const reference of extractReferences(record.description)) found.add(reference);
  return [...found];
}

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

// ---------------------------------------------------------------------------
// Leitura do arquivo
// ---------------------------------------------------------------------------

function parseOfxFile(content: Buffer, batch: BatchRow, account: BankAccountRow | null): ParsedFile {
  const { statement, matches } = pickStatement(readOfx(content), account?.account_number ?? null);
  if (matches === false && !batch.config?.allowAccountMismatch) {
    throw new ImportContentError(
      `A conta do arquivo (${statement.accountId ?? 'não informada'}) não corresponde à conta selecionada ` +
        `(${account?.name ?? '-'}${account?.account_number ? ` ${account.account_number}` : ''}). ` +
        'Reprocesse permitindo a divergência se o arquivo estiver correto.',
    );
  }
  const records: SourceRecord[] = [];
  let skipped = 0;
  statement.transactions.forEach((transaction, index) => {
    if (transaction.amountCents === 0) {
      skipped += 1;
      return;
    }
    records.push({
      rowNumber: index + 1,
      date: transaction.postedDate,
      amountCents: transaction.amountCents,
      description: ofxDescription(transaction),
      externalId: transaction.fitId,
      document: transaction.checkNumber,
      reference: transaction.refNumber,
      counterparty: transaction.name,
      dueDate: null,
      bankAccountRef: null,
      costCenter: null,
      category: null,
      bankType: transaction.type,
      raw: transaction.raw,
    });
  });
  // As posições das transações válidas e inválidas são as mesmas do extrato: a numeração não se repete.
  const rejections = statement.errors.map<Rejection>((error) => ({
    rowNumber: error.index + 1,
    kind: 'invalid',
    reason: error.message,
    raw: error.raw,
  }));
  const range = dateRange(records);
  return {
    records,
    rejections,
    skipped,
    periodStart: statement.startDate ?? range.start,
    periodEnd: statement.endDate ?? range.end,
  };
}

async function parseTabularFile(content: Buffer, batch: BatchRow): Promise<ParsedFile> {
  const parsedConfig = importProfileConfigSchema.safeParse(batch.config?.mapping);
  if (!parsedConfig.success) {
    throw new ImportContentError('O mapeamento de colunas do lote é inválido ou não foi informado.');
  }
  const config = parsedConfig.data;
  const format = batch.file_format === 'xlsx' ? 'xlsx' : 'csv';
  const table = await readTabular(format, content, tabularOptions(config));
  const mapped = mapTabular(table.rows, config);
  const records = mapped.records.map<SourceRecord>((record) => ({ ...record, bankType: null }));
  const range = dateRange(records);
  return {
    records,
    rejections: mapped.rejections.map((rejection) => ({ ...rejection, kind: 'invalid' as const })),
    skipped: mapped.skipped,
    periodStart: range.start,
    periodEnd: range.end,
  };
}

function rawOf(entry: unknown): Record<string, string> {
  const source = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
  const base = source.raw && typeof source.raw === 'object' ? (source.raw as Record<string, unknown>) : source;
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (base === source && key === 'raw') continue;
    if (value === undefined || value === null) continue;
    raw[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return raw;
}

/** Lote JSON (API de entrada e conector): `{ entries: LedgerEntryInputV1[] }`; cada item inválido vira rejeição. */
function parseJsonFile(content: Buffer, batch: BatchRow): ParsedFile {
  if (batch.source_kind !== 'ledger') throw new ImportContentError('Lote JSON só é aceito para lançamentos.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    throw new ImportContentError('O lote JSON é inválido.');
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) throw new ImportContentError('O lote JSON não contém a lista "entries".');
  const records: SourceRecord[] = [];
  const rejections: Rejection[] = [];
  entries.forEach((entry, index) => {
    const raw = rawOf(entry);
    const result = ledgerEntryInputV1Schema.safeParse(entry);
    if (!result.success) {
      const reason = result.error.issues
        .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
        .join('; ');
      rejections.push({ rowNumber: index + 1, kind: 'invalid', reason, raw });
      return;
    }
    const value = result.data;
    records.push({
      rowNumber: index + 1,
      date: value.date,
      amountCents: value.amountCents,
      description: value.description,
      externalId: value.externalId,
      document: value.document,
      reference: value.reference,
      counterparty: value.counterparty,
      dueDate: value.dueDate,
      bankAccountRef: value.bankAccountRef,
      costCenter: value.costCenter,
      category: value.category,
      bankType: null,
      raw,
    });
  });
  const range = dateRange(records);
  return { records, rejections, skipped: 0, periodStart: range.start, periodEnd: range.end };
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------

async function loadRules(db: Db, tenantId: string): Promise<ClassificationRule[]> {
  const result = await db.query<{
    id: string;
    name: string;
    priority: number;
    match_type: ClassificationRule['matchType'];
    pattern: string;
    applies_to: ClassificationRule['appliesTo'];
    direction: ClassificationRule['direction'];
    result_kind: ClassificationRule['resultKind'];
    category_id: string | null;
  }>(
    `SELECT id, name, priority, match_type, pattern, applies_to, direction, result_kind, category_id
       FROM classification_rules WHERE tenant_id = $1 AND active`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    priority: row.priority,
    matchType: row.match_type,
    pattern: row.pattern,
    appliesTo: row.applies_to,
    direction: row.direction,
    resultKind: row.result_kind,
    categoryId: row.category_id,
    active: true,
  }));
}

/** Serializa importações concorrentes do mesmo escopo (conta bancária ou lançamentos da empresa). */
async function lockScope(db: Db, scope: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope]);
}

/** Chaves já existentes que não entraram agora: do próprio lote (reprocessamento) ou de outro (duplicadas). */
async function existingBatchOf(
  db: Db,
  table: 'bank_transactions' | 'ledger_entries',
  tenantId: string,
  keys: string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const result = await db.query<{ dedup_key: string; batch_id: string }>(
    `SELECT dedup_key, batch_id FROM ${table} WHERE tenant_id = $1 AND dedup_key = ANY ($2::text[])`,
    [tenantId, keys],
  );
  return new Map(result.rows.map((row) => [row.dedup_key, row.batch_id]));
}

async function importBank(
  db: Db,
  batch: BatchRow,
  records: SourceRecord[],
  rules: ClassificationRule[],
): Promise<Counts> {
  const tenantId = batch.tenant_id;
  const accountId = batch.bank_account_id as string;
  await lockScope(db, `bank:${tenantId}:${accountId}`);

  const prepared = records.map((record) => ({ record, descriptionNorm: normalizeDescription(record.description) }));
  const keys = computeDedupKeys(
    accountId,
    prepared.map(({ record, descriptionNorm }) => ({
      date: record.date,
      amountCents: record.amountCents,
      descriptionNorm,
      externalId: record.externalId,
      document: record.document,
    })),
  );
  const counts: Counts = { imported: 0, inserted: 0, duplicates: 0, conflicts: 0, duplicateSuspects: 0, rejections: [] };

  const indexes = prepared.map((_, index) => index);
  for (const part of chunks(indexes)) {
    const rows = part.map((index) => {
      const { record, descriptionNorm } = prepared[index]!;
      const key = keys[index]!;
      const classification = classify({ side: 'bank', descriptionNorm, amountCents: record.amountCents }, rules);
      return {
        row_number: record.rowNumber,
        posted_date: record.date,
        amount_cents: record.amountCents,
        description_raw: record.description,
        description_norm: descriptionNorm,
        external_id: record.externalId,
        document: record.document,
        reference: record.reference,
        identifiers: identifiersOf(record),
        bank_type: record.bankType,
        raw: record.raw,
        dedup_key: key.dedupKey,
        similarity_key: key.similarityKey,
        kind: classification.kind,
        kind_rule: classification.ruleName,
        category_id: classification.categoryId,
      };
    });
    const inserted = await db.query<{ id: string; dedup_key: string; similarity_key: string }>(
      `INSERT INTO bank_transactions
         (tenant_id, bank_account_id, batch_id, row_number, posted_date, amount_cents, description_raw,
          description_norm, external_id, document, reference, identifiers, bank_type, raw, dedup_key,
          similarity_key, kind, kind_rule, category_id)
       SELECT $1, $2, $3, r.row_number, r.posted_date, r.amount_cents, r.description_raw, r.description_norm,
              r.external_id, r.document, r.reference, ARRAY(SELECT jsonb_array_elements_text(r.identifiers)),
              r.bank_type, r.raw, r.dedup_key, r.similarity_key, r.kind, r.kind_rule, r.category_id
         FROM jsonb_to_recordset($4::jsonb) AS r(
           row_number integer, posted_date date, amount_cents bigint, description_raw text, description_norm text,
           external_id text, document text, reference text, identifiers jsonb, bank_type text, raw jsonb,
           dedup_key text, similarity_key text, kind text, kind_rule text, category_id uuid)
       ON CONFLICT (tenant_id, bank_account_id, dedup_key) DO NOTHING
       RETURNING id, dedup_key, similarity_key`,
      [tenantId, accountId, batch.id, JSON.stringify(rows)],
    );
    const insertedKeys = new Set(inserted.rows.map((row) => row.dedup_key));
    counts.inserted += inserted.rows.length;
    counts.imported += inserted.rows.length;

    const missing = rows.map((row) => row.dedup_key).filter((key) => !insertedKeys.has(key));
    const existing = await existingBatchOf(db, 'bank_transactions', tenantId, missing);
    for (const key of missing) {
      if (existing.get(key) === batch.id) counts.imported += 1;
      else counts.duplicates += 1;
    }

    // Linha nova igual (data, valor e descrição) a uma de outro lote: possível duplicidade para decisão humana.
    if (inserted.rows.length === 0) continue;
    const similar = await db.query<{ similarity_key: string; id: string }>(
      `SELECT DISTINCT ON (similarity_key) similarity_key, id
         FROM bank_transactions
        WHERE tenant_id = $1 AND bank_account_id = $2 AND batch_id <> $3 AND similarity_key = ANY ($4::text[])
        ORDER BY similarity_key, posted_date, created_at, id`,
      [tenantId, accountId, batch.id, [...new Set(inserted.rows.map((row) => row.similarity_key))]],
    );
    const originalBySimilarity = new Map(similar.rows.map((row) => [row.similarity_key, row.id]));
    const suspects = inserted.rows
      .filter((row) => originalBySimilarity.has(row.similarity_key))
      .map((row) => ({
        bank_transaction_id: row.id,
        duplicate_of: originalBySimilarity.get(row.similarity_key) as string,
        pair_key: `duplicate:b:${row.id}`,
      }));
    if (suspects.length === 0) continue;
    counts.duplicateSuspects += suspects.length;
    await db.query(
      `UPDATE bank_transactions SET duplicate_suspect = true, recon_status = 'divergent'
        WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`,
      [tenantId, suspects.map((suspect) => suspect.bank_transaction_id)],
    );
    await db.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(bank_transaction_id uuid, duplicate_of uuid, pair_key text)
       ), created AS (
         INSERT INTO matches (tenant_id, bank_account_id, match_type, status, origin, divergence, pair_key,
                              explanation, breakdown)
         SELECT $1, $2, 'ignored', 'suggested', 'engine', 'duplicate', i.pair_key,
                'Possível duplicidade: outra transação com a mesma data, valor e descrição já foi importada em outro lote.',
                jsonb_build_object('duplicateOf', i.duplicate_of, 'batchId', $4::uuid)
           FROM input i
         RETURNING id, pair_key
       )
       INSERT INTO match_items (tenant_id, match_id, side, bank_transaction_id, active)
       SELECT $1, c.id, 'bank', i.bank_transaction_id, false
         FROM created c JOIN input i ON i.pair_key = c.pair_key`,
      [tenantId, accountId, JSON.stringify(suspects), batch.id],
    );
  }
  return counts;
}

function resolveAccountRef(ref: string | null, accounts: readonly BankAccountRow[]): string | null {
  if (!ref) return null;
  const identifier = normalizeIdentifier(ref);
  const name = normalizeDescription(ref);
  const number = digits(ref);
  const byRef = accounts.find((account) => account.external_ref && normalizeIdentifier(account.external_ref) === identifier);
  if (byRef) return byRef.id;
  const byName = accounts.find((account) => name !== '' && normalizeDescription(account.name) === name);
  if (byName) return byName.id;
  const byNumber = accounts.find((account) => number !== '' && digits(account.account_number) === number);
  return byNumber?.id ?? null;
}

async function importLedger(
  db: Db,
  batch: BatchRow,
  records: SourceRecord[],
  rules: ClassificationRule[],
): Promise<Counts> {
  const tenantId = batch.tenant_id;
  await lockScope(db, `ledger:${tenantId}`);

  const accounts = batch.bank_account_id
    ? []
    : (
        await db.query<BankAccountRow>(
          'SELECT id, name, account_number, external_ref, active FROM bank_accounts WHERE tenant_id = $1',
          [tenantId],
        )
      ).rows;

  const prepared = records.map((record) => {
    const descriptionNorm = normalizeDescription(record.description);
    const input = {
      date: record.date,
      amountCents: record.amountCents,
      descriptionNorm,
      externalId: record.externalId,
      document: record.document,
    };
    return { record, descriptionNorm, input, hash: contentHash(input) };
  });
  const keys = computeDedupKeys('ledger', prepared.map((entry) => entry.input));
  const counts: Counts = { imported: 0, inserted: 0, duplicates: 0, conflicts: 0, duplicateSuspects: 0, rejections: [] };

  const externalIds = [...new Set(prepared.map((entry) => entry.record.externalId).filter((id): id is string => !!id))];
  const existingById = new Map<string, { hash: string; batchId: string }[]>();
  for (const part of chunks(externalIds)) {
    const result = await db.query<{ external_id: string; content_hash: string; batch_id: string }>(
      `SELECT external_id, content_hash, batch_id FROM ledger_entries
        WHERE tenant_id = $1 AND external_id = ANY ($2::text[])`,
      [tenantId, part],
    );
    for (const row of result.rows) {
      const list = existingById.get(row.external_id) ?? [];
      list.push({ hash: row.content_hash, batchId: row.batch_id });
      existingById.set(row.external_id, list);
    }
  }

  const conflict = (entry: (typeof prepared)[number], reason: string) => {
    counts.conflicts += 1;
    counts.rejections.push({ rowNumber: entry.record.rowNumber, kind: 'conflict', reason, raw: entry.record.raw });
  };

  const seenInFile = new Map<string, string>();
  const toInsert: number[] = [];
  prepared.forEach((entry, index) => {
    const externalId = entry.record.externalId;
    if (externalId) {
      const seen = seenInFile.get(externalId);
      if (seen !== undefined) {
        if (seen === entry.hash) counts.duplicates += 1;
        else conflict(entry, `Identificador ${externalId} repetido no arquivo com conteúdo diferente.`);
        return;
      }
      seenInFile.set(externalId, entry.hash);
      const prior = existingById.get(externalId);
      if (prior && prior.length > 0) {
        const same = prior.filter((item) => item.hash === entry.hash);
        if (same.some((item) => item.batchId === batch.id)) counts.imported += 1;
        else if (same.length > 0) counts.duplicates += 1;
        // Identificador já importado com outro conteúdo: não sobrescreve; a pessoa decide.
        else conflict(entry, `Lançamento ${externalId} já importado com conteúdo diferente; o registro existente foi mantido.`);
        return;
      }
    }
    toInsert.push(index);
  });

  for (const part of chunks(toInsert)) {
    const rows = part.map((index) => {
      const { record, descriptionNorm, hash } = prepared[index]!;
      const classification = classify({ side: 'ledger', descriptionNorm, amountCents: record.amountCents }, rules);
      return {
        row_number: record.rowNumber,
        bank_account_id: batch.bank_account_id ?? resolveAccountRef(record.bankAccountRef, accounts),
        entry_date: record.date,
        due_date: record.dueDate,
        amount_cents: record.amountCents,
        description_raw: record.description,
        description_norm: descriptionNorm,
        external_id: record.externalId,
        document: record.document,
        reference: record.reference,
        counterparty: record.counterparty,
        cost_center_ref: record.costCenter,
        category_ref: record.category,
        identifiers: identifiersOf(record),
        raw: record.raw,
        dedup_key: keys[index]!.dedupKey,
        content_hash: hash,
        kind: classification.kind,
      };
    });
    const inserted = await db.query<{ dedup_key: string }>(
      `INSERT INTO ledger_entries
         (tenant_id, batch_id, row_number, bank_account_id, entry_date, due_date, amount_cents, description_raw,
          description_norm, external_id, document, reference, counterparty, cost_center_ref, category_ref,
          identifiers, raw, dedup_key, content_hash, kind)
       SELECT $1, $2, r.row_number, r.bank_account_id, r.entry_date, r.due_date, r.amount_cents, r.description_raw,
              r.description_norm, r.external_id, r.document, r.reference, r.counterparty, r.cost_center_ref,
              r.category_ref, ARRAY(SELECT jsonb_array_elements_text(r.identifiers)), r.raw, r.dedup_key,
              r.content_hash, r.kind
         FROM jsonb_to_recordset($3::jsonb) AS r(
           row_number integer, bank_account_id uuid, entry_date date, due_date date, amount_cents bigint,
           description_raw text, description_norm text, external_id text, document text, reference text,
           counterparty text, cost_center_ref text, category_ref text, identifiers jsonb, raw jsonb,
           dedup_key text, content_hash text, kind text)
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING
       RETURNING dedup_key`,
      [tenantId, batch.id, JSON.stringify(rows)],
    );
    const insertedKeys = new Set(inserted.rows.map((row) => row.dedup_key));
    counts.inserted += inserted.rows.length;
    counts.imported += inserted.rows.length;
    const missing = rows.map((row) => row.dedup_key).filter((key) => !insertedKeys.has(key));
    const existing = await existingBatchOf(db, 'ledger_entries', tenantId, missing);
    for (const key of missing) {
      if (existing.get(key) === batch.id) counts.imported += 1;
      else counts.duplicates += 1;
    }
  }
  return counts;
}

/** Grava rejeições sem repetir as de uma execução anterior do mesmo lote. */
async function insertRejections(db: Db, batch: BatchRow, rejections: readonly Rejection[]): Promise<void> {
  for (const part of chunks(rejections)) {
    await db.query(
      `INSERT INTO import_rejections (tenant_id, batch_id, row_number, kind, reason, raw)
       SELECT $1, $2, r.row_number, r.kind, r.reason, coalesce(r.raw, '{}')
         FROM jsonb_to_recordset($3::jsonb) AS r(row_number integer, kind text, reason text, raw jsonb)
        WHERE NOT EXISTS (
          SELECT 1 FROM import_rejections x
           WHERE x.tenant_id = $1 AND x.batch_id = $2 AND x.row_number = r.row_number AND x.kind = r.kind)`,
      [
        batch.tenant_id,
        batch.id,
        JSON.stringify(
          part.map((item) => ({ row_number: item.rowNumber, kind: item.kind, reason: item.reason, raw: item.raw })),
        ),
      ],
    );
  }
}

async function assertMonthlyLimit(db: Db, tenantId: string): Promise<void> {
  const limit = (await loadEntitlements(db, tenantId)).limits.maxMonthlyTransactions;
  if (limit === null) return;
  const result = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM bank_transactions
      WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())`,
    [tenantId],
  );
  if ((result.rows[0]?.total ?? 0) > limit) {
    throw new ImportContentError(
      `O plano permite até ${limit} transações bancárias importadas por mês; esta importação ultrapassaria o limite.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Manipulador
// ---------------------------------------------------------------------------

/** Evento de fim de importação: `import.completed` ou `import.failed`. */
async function notifyImport(
  db: Db,
  batch: Pick<BatchRow, 'id' | 'tenant_id' | 'file_name' | 'source_kind' | 'origin' | 'bank_account_id'>,
  status: 'completed' | 'completed_with_errors' | 'failed',
  stats: Partial<ImportStats> | null,
  error: string | null,
): Promise<void> {
  const failed = status === 'failed';
  await emitNotification(db, {
    tenantId: batch.tenant_id,
    event: failed ? 'import.failed' : 'import.completed',
    title: failed ? 'Importação com falha' : 'Importação concluída',
    body: failed
      ? `A importação de ${batch.file_name} falhou: ${error ?? 'erro não informado'}`
      : `Importação de ${batch.file_name}: ${stats?.imported ?? 0} importado(s), ${stats?.rejected ?? 0} rejeitado(s).`,
    link: `/importacoes/${batch.id}`,
    data: {
      batchId: batch.id,
      fileName: batch.file_name,
      sourceKind: batch.source_kind,
      origin: batch.origin,
      bankAccountId: batch.bank_account_id,
      status,
      stats,
      error,
    },
  });
}

async function finishBatch(
  context: JobContext,
  batch: BatchRow,
  status: 'completed' | 'completed_with_errors' | 'failed',
  stats: ImportStats,
  error: string | null,
): Promise<Record<string, unknown>> {
  await context.db.query(
    `UPDATE import_batches SET status = $3, stats = $4, error = $5, processed_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [batch.tenant_id, batch.id, status, JSON.stringify(stats), error],
  );
  await context.audit({
    action: 'import.processed',
    entityType: 'import_batch',
    entityId: batch.id,
    summary:
      status === 'failed'
        ? `Importação de ${batch.file_name} falhou: ${error}`
        : `Importação de ${batch.file_name}: ${stats.imported} importado(s), ${stats.duplicates} duplicado(s), ` +
          `${stats.rejected} rejeitado(s), ${stats.conflicts} conflito(s)`,
    after: { status, stats, error },
    metadata: { jobId: context.job.id, attempt: context.job.attempts },
  });
  await notifyImport(context.db, batch, status, stats, error);
  const source = batch.source_kind;
  const metrics = context.deps.metrics.importRows;
  if (stats.imported) metrics.inc({ source, result: 'imported' }, stats.imported);
  if (stats.duplicates) metrics.inc({ source, result: 'duplicate' }, stats.duplicates);
  if (stats.rejected) metrics.inc({ source, result: 'rejected' }, stats.rejected);
  if (stats.conflicts) metrics.inc({ source, result: 'conflict' }, stats.conflicts);
  return { batchId: batch.id, status, stats, error };
}

async function processImport(context: JobContext): Promise<unknown> {
  const { db, job, deps } = context;
  const batchId = typeof job.payload.batchId === 'string' ? job.payload.batchId : null;
  if (!batchId) throw new Error('Trabalho de importação sem lote');
  const batch = await findBatch(db, context.tenantId, batchId, true);
  // Lote já processado (execução repetida do mesmo trabalho): nada a fazer.
  if (batch.status !== 'queued' && batch.status !== 'processing') {
    return { batchId, status: batch.status, skipped: true };
  }

  const stats = emptyStats();
  const content = await loadBatchFile(db, batch.tenant_id, batch.id);
  if (!content) return finishBatch(context, batch, 'failed', stats, 'O arquivo original não está mais disponível.');

  await db.query('SAVEPOINT import_rows');
  let status: 'completed' | 'completed_with_errors';
  try {
    const account = batch.bank_account_id ? await findBankAccount(db, batch.tenant_id, batch.bank_account_id) : null;
    const parsed =
      batch.file_format === 'ofx'
        ? parseOfxFile(content, batch, account)
        : batch.file_format === 'json'
          ? parseJsonFile(content, batch)
          : await parseTabularFile(content, batch);
    const invalid = parsed.rejections.length;
    stats.totalRows = parsed.records.length + invalid + parsed.skipped;
    stats.skipped = parsed.skipped;
    stats.rejected = invalid;
    stats.periodStart = parsed.periodStart;
    stats.periodEnd = parsed.periodEnd;
    if (stats.totalRows > deps.config.maxImportRows) {
      throw new ImportContentError(
        `O arquivo tem ${stats.totalRows} linhas; o limite por importação é ${deps.config.maxImportRows}.`,
      );
    }
    if (batch.source_kind === 'bank' && !batch.bank_account_id) {
      throw new ImportContentError('Importação de extrato sem conta bancária.');
    }

    const rules = await loadRules(db, batch.tenant_id);
    const counts =
      batch.source_kind === 'bank'
        ? await importBank(db, batch, parsed.records, rules)
        : await importLedger(db, batch, parsed.records, rules);
    if (batch.source_kind === 'bank' && counts.inserted > 0) await assertMonthlyLimit(db, batch.tenant_id);
    await insertRejections(db, batch, [...parsed.rejections, ...counts.rejections]);
    await db.query('RELEASE SAVEPOINT import_rows');

    stats.imported = counts.imported;
    stats.duplicates = counts.duplicates;
    stats.conflicts = counts.conflicts;
    stats.duplicateSuspects = counts.duplicateSuspects;
    status = stats.rejected + stats.conflicts > 0 ? 'completed_with_errors' : 'completed';
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT import_rows');
    // Erro de conteúdo não melhora com nova tentativa: o trabalho conclui e o lote fica falho.
    if (error instanceof ImportContentError || error instanceof ImportConfigError) {
      return finishBatch(context, batch, 'failed', stats, error.message);
    }
    throw error;
  }
  return finishBatch(context, batch, status, stats, null);
}

function batchIdOf(job: JobRecord): string | null {
  return typeof job.payload.batchId === 'string' ? job.payload.batchId : null;
}

export const importProcessHandler: JobHandler = {
  run: processImport,
  onDead: async (db, job, error) => {
    const batchId = batchIdOf(job);
    if (!batchId) return;
    const message = `O processamento falhou após ${job.attempts} tentativa(s): ${error.slice(0, 500)}`;
    const updated = await db.query<BatchRow>(
      `UPDATE import_batches SET status = 'failed', error = $3, processed_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'processing')
        RETURNING *`,
      [job.tenant_id, batchId, message],
    );
    const batch = updated.rows[0];
    if (batch) await notifyImport(db, batch, 'failed', batch.stats, message);
  },
  onRetry: async (db, job) => {
    const batchId = batchIdOf(job);
    if (!batchId) return;
    await db.query(
      `UPDATE import_batches SET status = 'queued', error = NULL, processed_at = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = 'failed'`,
      [job.tenant_id, batchId],
    );
  },
};
