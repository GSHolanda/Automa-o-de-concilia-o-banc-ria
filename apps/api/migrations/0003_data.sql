-- 0003_data: fila de trabalhos, importações, transações, lançamentos e conciliações.

-- ---------------------------------------------------------------------------
-- Fila de trabalhos
-- ---------------------------------------------------------------------------

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  type             text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}',
  -- Único por empresa e tipo: enfileirar duas vezes a mesma operação não cria dois trabalhos.
  idempotency_key  text NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'succeeded', 'dead', 'canceled')),
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  run_at           timestamptz NOT NULL DEFAULT now(),
  locked_at        timestamptz,
  locked_by        text,
  last_error       text,
  result           jsonb,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, type, idempotency_key)
);
CREATE INDEX jobs_ready ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_tenant_status ON jobs (tenant_id, status, created_at DESC);
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('jobs');

-- ---------------------------------------------------------------------------
-- Importações
-- ---------------------------------------------------------------------------

CREATE TABLE import_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  source_kind      text NOT NULL CHECK (source_kind IN ('bank', 'ledger')),
  bank_account_id  uuid,
  profile_id       uuid,
  origin           text NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload', 'api', 'connector')),
  file_name        text NOT NULL,
  file_format      text NOT NULL CHECK (file_format IN ('ofx', 'csv', 'xlsx', 'json')),
  file_sha256      text NOT NULL,
  file_size        integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'uploaded'
                   CHECK (status IN ('uploaded', 'queued', 'processing', 'completed',
                                     'completed_with_errors', 'failed', 'canceled')),
  -- Mapeamento efetivamente usado, copiado do perfil no momento da confirmação.
  config           jsonb,
  stats            jsonb NOT NULL DEFAULT '{}',
  error            text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES import_profiles (tenant_id, id)
);
-- O mesmo arquivo não entra duas vezes para a mesma conta e origem (lotes falhos ou cancelados não contam).
CREATE UNIQUE INDEX import_batches_file_unique ON import_batches (
  tenant_id, source_kind, coalesce(bank_account_id, '00000000-0000-0000-0000-000000000000'::uuid), file_sha256
) WHERE status NOT IN ('failed', 'canceled');
CREATE INDEX import_batches_tenant ON import_batches (tenant_id, created_at DESC);
CREATE TRIGGER import_batches_updated_at BEFORE UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('import_batches');

-- Arquivo original, preservado como evidência. Pode ser expurgado conforme a política de retenção.
CREATE TABLE import_files (
  batch_id    uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  content     bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES import_batches (tenant_id, id)
);
SELECT _apply_tenant_rls('import_files');

CREATE TABLE import_rejections (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  batch_id     uuid NOT NULL,
  row_number   integer NOT NULL,
  -- invalid: linha ilegível. conflict: identificador já existente com conteúdo diferente.
  kind         text NOT NULL DEFAULT 'invalid' CHECK (kind IN ('invalid', 'conflict')),
  reason       text NOT NULL,
  raw          jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES import_batches (tenant_id, id)
);
CREATE INDEX import_rejections_batch ON import_rejections (tenant_id, batch_id, row_number);
SELECT _apply_tenant_rls('import_rejections');

-- ---------------------------------------------------------------------------
-- Transações de extrato e lançamentos do sistema financeiro
-- Colunas de origem são imutáveis; apenas o estado derivado pode mudar.
-- ---------------------------------------------------------------------------

CREATE TABLE bank_transactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  bank_account_id    uuid NOT NULL,
  batch_id           uuid NOT NULL,
  row_number         integer NOT NULL,
  -- origem
  posted_date        date NOT NULL,
  amount_cents       bigint NOT NULL CHECK (amount_cents <> 0),
  description_raw    text NOT NULL,
  description_norm   text NOT NULL,
  external_id        text,
  document           text,
  reference          text,
  identifiers        text[] NOT NULL DEFAULT '{}',
  bank_type          text,
  raw                jsonb NOT NULL DEFAULT '{}',
  dedup_key          text NOT NULL,
  similarity_key     text NOT NULL,
  -- estado derivado
  kind               text NOT NULL DEFAULT 'regular'
                     CHECK (kind IN ('regular', 'fee', 'tax', 'interest', 'reversal', 'internal_transfer')),
  kind_rule          text,
  category_id        uuid,
  recon_status       text NOT NULL DEFAULT 'pending'
                     CHECK (recon_status IN ('pending', 'reconciled', 'divergent', 'ignored')),
  duplicate_suspect  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, bank_account_id, dedup_key),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES import_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id)
);
CREATE INDEX bank_transactions_account_date ON bank_transactions (tenant_id, bank_account_id, posted_date);
CREATE INDEX bank_transactions_status ON bank_transactions (tenant_id, recon_status, posted_date);
CREATE INDEX bank_transactions_similarity ON bank_transactions (tenant_id, similarity_key);
CREATE INDEX bank_transactions_batch ON bank_transactions (tenant_id, batch_id);
SELECT _apply_tenant_rls('bank_transactions');

CREATE TABLE ledger_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  batch_id          uuid NOT NULL,
  row_number        integer NOT NULL,
  -- origem
  bank_account_id   uuid,
  entry_date        date NOT NULL,
  due_date          date,
  amount_cents      bigint NOT NULL CHECK (amount_cents <> 0),
  description_raw   text NOT NULL,
  description_norm  text NOT NULL,
  external_id       text,
  document          text,
  reference         text,
  counterparty      text,
  cost_center_ref   text,
  category_ref      text,
  identifiers       text[] NOT NULL DEFAULT '{}',
  raw               jsonb NOT NULL DEFAULT '{}',
  dedup_key         text NOT NULL,
  content_hash      text NOT NULL,
  -- estado derivado
  kind              text NOT NULL DEFAULT 'regular'
                    CHECK (kind IN ('regular', 'fee', 'tax', 'interest', 'reversal', 'internal_transfer')),
  recon_status      text NOT NULL DEFAULT 'pending'
                    CHECK (recon_status IN ('pending', 'reconciled', 'divergent', 'ignored')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedup_key),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES import_batches (tenant_id, id)
);
CREATE INDEX ledger_entries_account_date ON ledger_entries (tenant_id, bank_account_id, entry_date);
CREATE INDEX ledger_entries_status ON ledger_entries (tenant_id, recon_status, entry_date);
CREATE INDEX ledger_entries_external ON ledger_entries (tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX ledger_entries_batch ON ledger_entries (tenant_id, batch_id);
SELECT _apply_tenant_rls('ledger_entries');

CREATE FUNCTION source_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['kind', 'kind_rule', 'category_id', 'recon_status', 'duplicate_suspect'];
  old_row jsonb;
  new_row jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'registros de origem não podem ser apagados (%)', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  old_row := to_jsonb(OLD) - mutable;
  new_row := to_jsonb(NEW) - mutable;
  IF old_row IS DISTINCT FROM new_row THEN
    RAISE EXCEPTION 'dados de origem são imutáveis (%)', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_transactions_immutable BEFORE UPDATE OR DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION source_record_immutable();
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION source_record_immutable();

-- ---------------------------------------------------------------------------
-- Execuções de conciliação e decisões
-- ---------------------------------------------------------------------------

CREATE TABLE reconciliation_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  bank_account_id  uuid NOT NULL,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  -- Regras vigentes no momento da execução: o resultado é reproduzível.
  rules_snapshot   jsonb NOT NULL,
  engine_version   text,
  stats            jsonb NOT NULL DEFAULT '{}',
  error            text,
  started_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (tenant_id, id),
  CHECK (period_end >= period_start),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_accounts (tenant_id, id)
);
CREATE INDEX reconciliation_runs_tenant ON reconciliation_runs (tenant_id, created_at DESC);
SELECT _apply_tenant_rls('reconciliation_runs');

CREATE TABLE matches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  run_id            uuid,
  bank_account_id   uuid,
  match_type        text NOT NULL
                    CHECK (match_type IN ('identifier', 'amount_date', 'tolerance', 'group', 'internal_transfer',
                                          'reversal', 'classification', 'manual', 'ignored')),
  -- suggested: aguardando revisão. pending_approval: aguardando segunda aprovação.
  -- confirmed: conciliação vigente. rejected, superseded, undone: encerradas.
  status            text NOT NULL
                    CHECK (status IN ('suggested', 'pending_approval', 'confirmed', 'rejected', 'superseded', 'undone')),
  origin            text NOT NULL CHECK (origin IN ('engine', 'user')),
  auto_confirmed    boolean NOT NULL DEFAULT false,
  rule_code         text,
  engine_version    text,
  confidence        numeric(5, 4),
  breakdown         jsonb,
  explanation       text,
  difference_cents  bigint NOT NULL DEFAULT 0,
  date_diff_days    integer NOT NULL DEFAULT 0,
  divergence        text CHECK (divergence IN ('amount', 'date', 'duplicate')),
  ambiguous         boolean NOT NULL DEFAULT false,
  category_id       uuid,
  -- Identidade do conjunto de itens; evita repetir sugestão já rejeitada.
  pair_key          text NOT NULL,
  proposed_by       uuid,
  proposed_at       timestamptz,
  proposal_note     text,
  decided_by        uuid,
  decided_at        timestamptz,
  decision_note     text,
  undone_by         uuid,
  undone_at         timestamptz,
  undo_reason       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES reconciliation_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id)
);
CREATE INDEX matches_tenant_status ON matches (tenant_id, status, created_at DESC);
CREATE INDEX matches_pair ON matches (tenant_id, pair_key) WHERE status = 'rejected';
CREATE INDEX matches_run ON matches (tenant_id, run_id);
CREATE TRIGGER matches_updated_at BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('matches');

CREATE TABLE match_items (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  match_id             uuid NOT NULL,
  side                 text NOT NULL CHECK (side IN ('bank', 'ledger')),
  bank_transaction_id  uuid,
  ledger_entry_id      uuid,
  -- Verdadeiro enquanto a conciliação está vigente ou aguardando aprovação: o item fica reservado.
  active               boolean NOT NULL DEFAULT false,
  CHECK (
    (side = 'bank' AND bank_transaction_id IS NOT NULL AND ledger_entry_id IS NULL)
    OR (side = 'ledger' AND ledger_entry_id IS NOT NULL AND bank_transaction_id IS NULL)
  ),
  FOREIGN KEY (tenant_id, match_id) REFERENCES matches (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_transaction_id) REFERENCES bank_transactions (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_entry_id) REFERENCES ledger_entries (tenant_id, id)
);
-- Um item participa de no máximo uma conciliação vigente. Garante a exclusão mútua entre decisões concorrentes.
CREATE UNIQUE INDEX match_items_bank_active ON match_items (tenant_id, bank_transaction_id)
  WHERE active AND bank_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX match_items_ledger_active ON match_items (tenant_id, ledger_entry_id)
  WHERE active AND ledger_entry_id IS NOT NULL;
CREATE INDEX match_items_match ON match_items (tenant_id, match_id);
CREATE INDEX match_items_bank ON match_items (tenant_id, bank_transaction_id);
CREATE INDEX match_items_ledger ON match_items (tenant_id, ledger_entry_id);
SELECT _apply_tenant_rls('match_items');

GRANT SELECT, INSERT, UPDATE ON
  jobs, import_batches, import_rejections, bank_transactions, ledger_entries,
  reconciliation_runs, matches, match_items
TO {{app_role}};
GRANT SELECT, INSERT, DELETE ON import_files TO {{app_role}};
