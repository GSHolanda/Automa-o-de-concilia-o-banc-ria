-- 0007_revisao_seguranca: correções da revisão de segurança de 16/11/2026 (achados 5, 6, 8 e 13).

-- ---------------------------------------------------------------------------
-- Achado 8: a linha de users não promove o próprio usuário nem muda de empresa
-- ---------------------------------------------------------------------------

-- Fora do contexto de plataforma, empresa e marca de operador não mudam. Ninguém altera o próprio acesso
-- (empresa, papel, situação, operador), nem com uma rota futura que grave colunas a mais.
CREATE FUNCTION users_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id = app_user_id() AND (
       NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.role_id IS DISTINCT FROM OLD.role_id
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.is_platform_admin IS DISTINCT FROM OLD.is_platform_admin) THEN
    RAISE EXCEPTION 'Você não pode alterar o próprio papel, a própria situação ou a própria empresa.'
      USING ERRCODE = '42501', HINT = 'self_access';
  END IF;
  IF NOT app_is_platform() AND (
       NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.is_platform_admin IS DISTINCT FROM OLD.is_platform_admin) THEN
    RAISE EXCEPTION 'Empresa do usuário e acesso de operador só mudam pela plataforma.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_guard BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_guard();

-- No contexto de plataforma só as linhas de operadores (tenant_id nulo) ficam visíveis; a criação do
-- administrador de uma empresa nova acontece com app.tenant_id já definido para ela (provisionamento).
DROP POLICY users_select ON users;
DROP POLICY users_insert ON users;
DROP POLICY users_update ON users;
CREATE POLICY users_select ON users FOR SELECT
  USING (tenant_id = app_tenant_id() OR id = app_user_id() OR (app_is_platform() AND tenant_id IS NULL));
CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() OR (app_is_platform() AND tenant_id IS NULL));
CREATE POLICY users_update ON users FOR UPDATE
  USING (tenant_id = app_tenant_id() OR id = app_user_id() OR (app_is_platform() AND tenant_id IS NULL))
  WITH CHECK (tenant_id = app_tenant_id() OR (app_is_platform() AND tenant_id IS NULL));

-- Contagem de usuários ativos de uma empresa, só para o operador da plataforma. Não devolve linhas.
CREATE FUNCTION platform_tenant_active_users(p_tenant_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN app_is_platform()
              THEN (SELECT count(*)::int FROM users u WHERE u.tenant_id = p_tenant_id AND u.status = 'active')
         END
$$;

-- ---------------------------------------------------------------------------
-- Achado 6: quatro olhos não se contornam com conta criada ou alterada por quem propôs
-- ---------------------------------------------------------------------------

-- Quem criou o usuário, redefiniu a senha ou mudou papel, situação ou permissões do papel, e quando.
ALTER TABLE users ADD COLUMN access_changed_by uuid;
ALTER TABLE users ADD COLUMN access_changed_at timestamptz;

-- Com quatro olhos ligado, a aprovação não vale se a conta do aprovador foi criada ou teve o acesso
-- alterado por quem propôs, depois da proposta.
CREATE FUNCTION matches_four_eyes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'pending_approval' AND NEW.status = 'confirmed'
     AND OLD.proposed_by IS NOT NULL AND NEW.decided_by IS NOT NULL
     AND coalesce((SELECT (s.data #>> '{approvals,fourEyes}')::boolean
                     FROM tenant_settings s WHERE s.tenant_id = NEW.tenant_id), true)
     AND EXISTS (
       SELECT 1 FROM users u
        WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.decided_by
          AND u.access_changed_by = OLD.proposed_by
          AND u.access_changed_at >= coalesce(OLD.proposed_at, '-infinity'::timestamptz)) THEN
    RAISE EXCEPTION 'A aprovação precisa vir de outra pessoa: esta conta foi criada ou alterada por quem propôs a conciliação.'
      USING ERRCODE = '42501', HINT = 'four_eyes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER matches_four_eyes_guard BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION matches_four_eyes_guard();

-- ---------------------------------------------------------------------------
-- Achado 5: espera crescente por conta e origem, em vez de bloqueio da conta inteira
-- ---------------------------------------------------------------------------

-- Falhas de login por par usuário + origem (IP). Sem políticas e sem permissões para a aplicação:
-- só as funções SECURITY DEFINER abaixo leem e gravam.
CREATE TABLE login_throttle (
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source           text NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  failures         integer NOT NULL DEFAULT 0,
  blocked_until    timestamptz,
  last_failure_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source)
);
ALTER TABLE login_throttle ENABLE ROW LEVEL SECURITY;

-- Fim da espera vigente para o par, ou nulo.
CREATE FUNCTION auth_login_blocked_until(p_user_id uuid, p_source text)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.blocked_until FROM login_throttle t
   WHERE t.user_id = p_user_id AND t.source = p_source AND t.blocked_until > now()
$$;

-- Conta a falha do par. A partir de p_free_attempts falhas, espera de 30 s que dobra a cada nova falha,
-- até p_max_minutes. Falhas com mais de 24 h são esquecidas. Devolve o fim da espera, se houver.
DROP FUNCTION auth_register_login_failure(uuid, integer, integer);
CREATE FUNCTION auth_register_login_failure(p_user_id uuid, p_source text, p_free_attempts integer, p_max_minutes integer)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_failures integer;
  v_until timestamptz;
BEGIN
  DELETE FROM login_throttle
   WHERE user_id = p_user_id AND last_failure_at < now() - interval '24 hours'
     AND (blocked_until IS NULL OR blocked_until < now());
  INSERT INTO login_throttle AS t (user_id, source, failures, last_failure_at)
  VALUES (p_user_id, left(p_source, 100), 1, now())
  ON CONFLICT (user_id, source) DO UPDATE SET failures = t.failures + 1, last_failure_at = now()
  RETURNING failures INTO v_failures;
  IF v_failures >= p_free_attempts THEN
    v_until := now() + least(
      make_interval(mins => p_max_minutes),
      make_interval(secs => 30 * power(2, least(v_failures - p_free_attempts, 16))::integer));
    UPDATE login_throttle SET blocked_until = v_until WHERE user_id = p_user_id AND source = left(p_source, 100);
  END IF;
  UPDATE users SET failed_logins = failed_logins + 1 WHERE id = p_user_id;
  RETURN v_until;
END $$;

-- Sucesso esquece as falhas daquela origem; as de outras origens seguem valendo.
DROP FUNCTION auth_register_login_success(uuid);
CREATE FUNCTION auth_register_login_success(p_user_id uuid, p_source text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM login_throttle WHERE user_id = p_user_id AND source = left(p_source, 100);
  UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- Achado 13: o login precisa da data da senha para recusar senha temporária vencida
-- ---------------------------------------------------------------------------

DROP FUNCTION auth_find_user(text);
CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (
  id uuid, tenant_id uuid, role_id uuid, email text, name text, password_hash text, status text,
  is_platform_admin boolean, must_change_password boolean, failed_logins integer,
  locked_until timestamptz, tenant_status text, password_changed_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.role_id, u.email, u.name, u.password_hash, u.status,
         u.is_platform_admin, u.must_change_password, u.failed_logins, u.locked_until, t.status,
         u.password_changed_at
    FROM users u
    LEFT JOIN tenants t ON t.id = u.tenant_id
   WHERE lower(u.email) = lower(p_email)
$$;

REVOKE ALL ON FUNCTION
  platform_tenant_active_users(uuid),
  auth_login_blocked_until(uuid, text),
  auth_register_login_failure(uuid, text, integer, integer),
  auth_register_login_success(uuid, text),
  auth_find_user(text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  platform_tenant_active_users(uuid),
  auth_login_blocked_until(uuid, text),
  auth_register_login_failure(uuid, text, integer, integer),
  auth_register_login_success(uuid, text),
  auth_find_user(text)
TO {{app_role}};
