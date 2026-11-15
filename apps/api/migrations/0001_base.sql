-- 0001_base: funções de contexto, empresas, planos, licenças, módulos, papéis, usuários, sessões e auditoria.
-- {{app_role}} é substituído pelo executor de migrações pelo papel de banco usado pela aplicação.

-- ---------------------------------------------------------------------------
-- Contexto da requisição (definido pela aplicação com set_config(..., true))
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app_is_platform() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.platform', true), '') = 'on'
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Política padrão de isolamento: a linha só é visível e gravável pela empresa do contexto.
CREATE FUNCTION _apply_tenant_rls(tbl regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
    tbl
  );
END $$;

-- ---------------------------------------------------------------------------
-- Empresas
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$'),
  legal_name  text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
  trade_name  text NOT NULL CHECK (length(trade_name) BETWEEN 1 AND 200),
  tax_id      text CHECK (tax_id IS NULL OR tax_id ~ '^[0-9]{11,14}$'),
  status      text NOT NULL DEFAULT 'onboarding'
              CHECK (status IN ('onboarding', 'active', 'suspended', 'archived')),
  onboarding  jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Fora do contexto de plataforma, a empresa só pode concluir o próprio onboarding; não muda slug nem se reativa.
CREATE FUNCTION tenants_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_platform() THEN
    RETURN NEW;
  END IF;
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'slug da empresa só pode ser alterado pela plataforma' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'onboarding' AND NEW.status = 'active') THEN
    RAISE EXCEPTION 'situação da empresa só pode ser alterada pela plataforma' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_guard BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION tenants_guard();

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_select ON tenants FOR SELECT USING (id = app_tenant_id() OR app_is_platform());
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (app_is_platform());
CREATE POLICY tenants_update ON tenants FOR UPDATE
  USING (id = app_tenant_id() OR app_is_platform())
  WITH CHECK (id = app_tenant_id() OR app_is_platform());

-- ---------------------------------------------------------------------------
-- Planos, licenças e módulos (base para licenciamento; sem provedor de pagamento)
-- ---------------------------------------------------------------------------

CREATE TABLE plans (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z0-9_-]{2,40}$'),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  limits       jsonb NOT NULL DEFAULT '{}',
  modules      text[] NOT NULL DEFAULT '{}',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER plans_updated_at BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY plans_select ON plans FOR SELECT USING (true);
CREATE POLICY plans_insert ON plans FOR INSERT WITH CHECK (app_is_platform());
CREATE POLICY plans_update ON plans FOR UPDATE USING (app_is_platform()) WITH CHECK (app_is_platform());

INSERT INTO plans (code, name, description, limits, modules) VALUES
  ('essencial', 'Essencial', 'Conciliação com importação de arquivos.',
   '{"maxUsers": 5, "maxBankAccounts": 3, "maxMonthlyTransactions": 5000}',
   ARRAY['transfers']),
  ('profissional', 'Profissional', 'Inclui aprovação em duas etapas, agrupamento e API de entrada.',
   '{"maxUsers": 25, "maxBankAccounts": 15, "maxMonthlyTransactions": 50000}',
   ARRAY['transfers', 'approvals', 'grouping', 'api.inbound', 'notifications.webhook', 'notifications.email']),
  ('corporativo', 'Corporativo', 'Todos os módulos, sem limites padrão.',
   '{"maxUsers": null, "maxBankAccounts": null, "maxMonthlyTransactions": null}',
   ARRAY['transfers', 'approvals', 'grouping', 'api.inbound', 'connector.rest', 'notifications.webhook',
         'notifications.email', 'ai.assist']);

CREATE TABLE tenant_licenses (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants (id),
  plan_code        text NOT NULL REFERENCES plans (code),
  status           text NOT NULL DEFAULT 'trial'
                   CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'canceled')),
  valid_from       date NOT NULL DEFAULT current_date,
  valid_until      date,
  limits_override  jsonb NOT NULL DEFAULT '{}',
  -- Referência em sistema de cobrança externo, quando houver. O produto não presume provedor.
  external_ref     text,
  notes            text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenant_licenses_updated_at BEFORE UPDATE ON tenant_licenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE tenant_licenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_licenses_select ON tenant_licenses FOR SELECT
  USING (tenant_id = app_tenant_id() OR app_is_platform());
CREATE POLICY tenant_licenses_insert ON tenant_licenses FOR INSERT WITH CHECK (app_is_platform());
CREATE POLICY tenant_licenses_update ON tenant_licenses FOR UPDATE
  USING (app_is_platform()) WITH CHECK (app_is_platform());

CREATE TABLE tenant_modules (
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  module_key  text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  config      jsonb NOT NULL DEFAULT '{}',
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_key)
);
CREATE TRIGGER tenant_modules_updated_at BEFORE UPDATE ON tenant_modules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_modules_all ON tenant_modules
  USING (tenant_id = app_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());

-- ---------------------------------------------------------------------------
-- Papéis e usuários
-- ---------------------------------------------------------------------------

CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  key          text NOT NULL CHECK (key ~ '^[a-z0-9_-]{2,40}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description  text NOT NULL DEFAULT '',
  is_system    boolean NOT NULL DEFAULT false,
  permissions  text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER roles_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT _apply_tenant_rls('roles');

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nulo apenas para operadores da plataforma.
  tenant_id             uuid REFERENCES tenants (id),
  role_id               uuid,
  email                 text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  password_hash         text NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  is_platform_admin     boolean NOT NULL DEFAULT false,
  must_change_password  boolean NOT NULL DEFAULT false,
  failed_logins         integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT users_role_fk FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  CONSTRAINT users_scope CHECK (
    (is_platform_admin AND tenant_id IS NULL AND role_id IS NULL)
    OR (NOT is_platform_admin AND tenant_id IS NOT NULL AND role_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE INDEX users_tenant ON users (tenant_id);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT
  USING (tenant_id = app_tenant_id() OR id = app_user_id() OR app_is_platform());
CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());
CREATE POLICY users_update ON users FOR UPDATE
  USING (tenant_id = app_tenant_id() OR id = app_user_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant_id() OR id = app_user_id() OR app_is_platform());

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id),
  tenant_id       uuid REFERENCES tenants (id),
  -- Apenas o SHA-256 do token; o token em si só existe no cookie do usuário.
  token_hash      bytea NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  -- Limite de inatividade vigente quando a sessão foi criada (configuração da empresa).
  idle_minutes    integer NOT NULL DEFAULT 60 CHECK (idle_minutes BETWEEN 5 AND 1440),
  revoked_at      timestamptz,
  revoked_reason  text,
  ip              text,
  user_agent      text
);
CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_select ON sessions FOR SELECT
  USING (user_id = app_user_id() OR tenant_id = app_tenant_id());
CREATE POLICY sessions_insert ON sessions FOR INSERT WITH CHECK (user_id = app_user_id());
CREATE POLICY sessions_update ON sessions FOR UPDATE
  USING (user_id = app_user_id() OR tenant_id = app_tenant_id())
  WITH CHECK (user_id = app_user_id() OR tenant_id = app_tenant_id());

-- ---------------------------------------------------------------------------
-- Trilha de auditoria: somente inserção, encadeada por hash em cada empresa
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Nulo para eventos da plataforma.
  tenant_id    uuid REFERENCES tenants (id),
  seq          bigint NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'system', 'api_token', 'platform')),
  actor_id     uuid,
  -- Nome do autor no momento do evento, preservado mesmo que o cadastro mude.
  actor_label  text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  summary      text NOT NULL DEFAULT '',
  before       jsonb,
  after        jsonb,
  metadata     jsonb NOT NULL DEFAULT '{}',
  request_id   text,
  ip           text,
  prev_hash    bytea,
  hash         bytea NOT NULL
);
CREATE UNIQUE INDEX audit_log_chain
  ON audit_log (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), seq);
CREATE INDEX audit_log_tenant_time ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_entity ON audit_log (tenant_id, entity_type, entity_id);

CREATE FUNCTION audit_log_hash(r audit_log) RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT sha256(convert_to(concat_ws(
    E'\x1f',
    encode(coalesce(r.prev_hash, ''::bytea), 'hex'),
    r.seq::text,
    coalesce(r.tenant_id::text, ''),
    to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    r.actor_type,
    coalesce(r.actor_id::text, ''),
    coalesce(r.actor_label, ''),
    r.action,
    r.entity_type,
    coalesce(r.entity_id, ''),
    r.summary,
    coalesce(r.before::text, ''),
    coalesce(r.after::text, ''),
    r.metadata::text,
    coalesce(r.request_id, ''),
    coalesce(r.ip, '')
  ), 'UTF8'))
$$;

-- SECURITY DEFINER: precisa ler o último registro da cadeia independentemente do contexto.
CREATE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  chain uuid := coalesce(NEW.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid);
  last_seq bigint;
  last_hash bytea;
BEGIN
  -- Uma inserção por vez em cada cadeia.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || chain::text, 0));
  SELECT seq, hash INTO last_seq, last_hash
    FROM audit_log
   WHERE coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) = chain
   ORDER BY seq DESC
   LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.occurred_at := clock_timestamp();
  NEW.hash := audit_log_hash(NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a trilha de auditoria não pode ser alterada nem apagada' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Recalcula a cadeia visível no contexto atual. broken_seq nulo significa cadeia íntegra.
CREATE FUNCTION audit_verify_chain(p_tenant uuid)
RETURNS TABLE (checked bigint, broken_seq bigint, head_seq bigint, head_hash text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_log%ROWTYPE;
  expected_prev bytea := NULL;
  expected_seq bigint := 1;
  n bigint := 0;
BEGIN
  FOR r IN SELECT * FROM audit_log WHERE tenant_id IS NOT DISTINCT FROM p_tenant ORDER BY seq LOOP
    IF r.seq <> expected_seq OR r.prev_hash IS DISTINCT FROM expected_prev OR r.hash <> audit_log_hash(r) THEN
      checked := n;
      broken_seq := r.seq;
      head_seq := NULL;
      head_hash := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
    expected_prev := r.hash;
    expected_seq := r.seq + 1;
    n := n + 1;
  END LOOP;
  checked := n;
  broken_seq := NULL;
  head_seq := expected_seq - 1;
  head_hash := encode(expected_prev, 'hex');
  RETURN NEXT;
END $$;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (tenant_id = app_tenant_id() OR (tenant_id IS NULL AND app_is_platform()));
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() OR (tenant_id IS NULL AND app_is_platform()));

-- ---------------------------------------------------------------------------
-- Privilégios do papel da aplicação
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON tenants, plans, tenant_licenses, tenant_modules, users, sessions TO {{app_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO {{app_role}};
GRANT SELECT, INSERT ON audit_log TO {{app_role}};
