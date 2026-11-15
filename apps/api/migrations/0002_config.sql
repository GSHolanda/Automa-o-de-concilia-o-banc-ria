-- 0002_config: configuração por empresa (cadastros, regras, perfis, integrações, notificações).

CREATE TABLE tenant_settings (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants (id),
  -- Incrementado a cada gravação; usado para detectar edição concorrente.
  version     integer NOT NULL DEFAULT 1,
  -- Documento validado pelo esquema de configurações do domínio (packages/core).
  data        jsonb NOT NULL DEFAULT '{}',
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT _apply_tenant_rls('tenant_settings');

-- Unidades, departamentos e centros de custo.
CREATE TABLE org_nodes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  kind        text NOT NULL CHECK (kind IN ('unit', 'department', 'cost_center')),
  code        text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  parent_id   uuid,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES org_nodes (tenant_id, id)
);
CREATE TRIGGER org_nodes_updated_at BEFORE UPDATE ON org_nodes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('org_nodes');

CREATE TABLE chart_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  code          text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  account_type  text NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  parent_id     uuid,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES chart_accounts (tenant_id, id)
);
CREATE TRIGGER chart_accounts_updated_at BEFORE UPDATE ON chart_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('chart_accounts');

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  code        text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind        text NOT NULL CHECK (kind IN ('fee', 'tax', 'interest', 'transfer', 'revenue', 'expense', 'other')),
  account_id  uuid,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, account_id) REFERENCES chart_accounts (tenant_id, id)
);
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('categories');

CREATE TABLE bank_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  bank_code          text CHECK (bank_code IS NULL OR bank_code ~ '^[0-9]{1,8}$'),
  bank_name          text,
  branch             text,
  account_number     text,
  currency           char(3) NOT NULL DEFAULT 'BRL',
  unit_id            uuid,
  ledger_account_id  uuid,
  -- Como o sistema financeiro identifica esta conta nos arquivos de lançamentos.
  external_ref       text,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org_nodes (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_account_id) REFERENCES chart_accounts (tenant_id, id)
);
CREATE TRIGGER bank_accounts_updated_at BEFORE UPDATE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('bank_accounts');

CREATE TABLE import_profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  source_kind  text NOT NULL CHECK (source_kind IN ('bank', 'ledger')),
  file_format  text NOT NULL CHECK (file_format IN ('csv', 'xlsx')),
  config       jsonb NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE TRIGGER import_profiles_updated_at BEFORE UPDATE ON import_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('import_profiles');

CREATE TABLE classification_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  priority     integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  match_type   text NOT NULL CHECK (match_type IN ('contains', 'starts_with', 'equals', 'contains_all')),
  pattern      text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 200),
  applies_to   text NOT NULL DEFAULT 'bank' CHECK (applies_to IN ('bank', 'ledger', 'both')),
  direction    text NOT NULL DEFAULT 'any' CHECK (direction IN ('any', 'credit', 'debit')),
  result_kind  text NOT NULL
               CHECK (result_kind IN ('regular', 'fee', 'tax', 'interest', 'reversal', 'internal_transfer')),
  category_id  uuid,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id)
);
CREATE TRIGGER classification_rules_updated_at BEFORE UPDATE ON classification_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('classification_rules');

CREATE TABLE report_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind        text NOT NULL CHECK (kind IN ('items', 'summary')),
  config      jsonb NOT NULL DEFAULT '{}',
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE TRIGGER report_templates_updated_at BEFORE UPDATE ON report_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('report_templates');

-- Integrações externas. O segredo é cifrado pela aplicação (AES-256-GCM) antes de chegar ao banco.
CREATE TABLE integrations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  kind                text NOT NULL CHECK (kind IN ('webhook', 'smtp', 'rest_ledger', 'ai_provider')),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  config              jsonb NOT NULL DEFAULT '{}',
  secret_ciphertext   bytea,
  secret_key_version  integer,
  -- verified só é gravado após chamada real bem-sucedida ao serviço externo.
  status              text NOT NULL DEFAULT 'not_configured'
                      CHECK (status IN ('not_configured', 'configured', 'verified', 'error')),
  last_checked_at     timestamptz,
  last_error          text,
  active              boolean NOT NULL DEFAULT true,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE TRIGGER integrations_updated_at BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('integrations');

-- Tokens de API para entrada de lançamentos. Guarda-se apenas o SHA-256 do token.
CREATE TABLE api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  token_prefix  text NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  scopes        text[] NOT NULL DEFAULT '{}',
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
SELECT _apply_tenant_rls('api_tokens');

CREATE TABLE notification_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  event           text NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('in_app', 'email', 'webhook')),
  -- in_app: {"roleKeys": [...]}; email: {"emails": [...]}; webhook: usa integration_id.
  target          jsonb NOT NULL DEFAULT '{}',
  integration_id  uuid,
  template        jsonb NOT NULL DEFAULT '{}',
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations (tenant_id, id)
);
CREATE TRIGGER notification_rules_updated_at BEFORE UPDATE ON notification_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('notification_rules');

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  user_id     uuid NOT NULL,
  event       text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX notifications_user ON notifications (tenant_id, user_id, created_at DESC);
SELECT _apply_tenant_rls('notifications');

-- Registro de cada tentativa de entrega externa: evidência de sucesso ou falha.
CREATE TABLE notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  rule_id         uuid,
  integration_id  uuid,
  channel         text NOT NULL CHECK (channel IN ('email', 'webhook')),
  event           text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts        integer NOT NULL DEFAULT 0,
  response_status integer,
  error           text,
  payload         jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX notification_deliveries_tenant ON notification_deliveries (tenant_id, created_at DESC);
SELECT _apply_tenant_rls('notification_deliveries');

GRANT SELECT, INSERT, UPDATE ON tenant_settings, bank_accounts, api_tokens, notification_deliveries TO {{app_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON
  org_nodes, chart_accounts, categories, import_profiles, classification_rules, report_templates,
  integrations, notification_rules, notifications
TO {{app_role}};
