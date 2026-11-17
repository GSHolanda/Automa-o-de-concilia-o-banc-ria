-- 0004_functions: operações anteriores ao contexto de empresa.
-- São SECURITY DEFINER, de escopo estreito, e as únicas formas de o papel da aplicação
-- enxergar dados sem contexto: localizar usuário no login, sessão por token, token de API e fila.

CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (
  id uuid, tenant_id uuid, role_id uuid, email text, name text, password_hash text, status text,
  is_platform_admin boolean, must_change_password boolean, failed_logins integer,
  locked_until timestamptz, tenant_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.role_id, u.email, u.name, u.password_hash, u.status,
         u.is_platform_admin, u.must_change_password, u.failed_logins, u.locked_until, t.status
    FROM users u
    LEFT JOIN tenants t ON t.id = u.tenant_id
   WHERE lower(u.email) = lower(p_email)
$$;

CREATE FUNCTION auth_register_login_failure(p_user_id uuid, p_max_attempts integer, p_lock_minutes integer)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users
     SET failed_logins = failed_logins + 1,
         locked_until = CASE
           WHEN failed_logins + 1 >= p_max_attempts THEN now() + make_interval(mins => p_lock_minutes)
           ELSE locked_until
         END
   WHERE id = p_user_id
$$;

CREATE FUNCTION auth_register_login_success(p_user_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = p_user_id
$$;

CREATE FUNCTION auth_find_session(p_token_hash bytea)
RETURNS TABLE (
  session_id uuid, user_id uuid, tenant_id uuid, created_at timestamptz, last_seen_at timestamptz,
  expires_at timestamptz, revoked_at timestamptz, user_status text, role_id uuid,
  is_platform_admin boolean, must_change_password boolean, name text, email text, tenant_status text,
  role_key text, role_name text, permissions text[], idle_minutes integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.user_id, u.tenant_id, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
         u.status, u.role_id, u.is_platform_admin, u.must_change_password, u.name, u.email, t.status,
         r.key, r.name, coalesce(r.permissions, '{}'), s.idle_minutes
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN tenants t ON t.id = u.tenant_id
    LEFT JOIN roles r ON r.id = u.role_id AND r.tenant_id = u.tenant_id
   WHERE s.token_hash = p_token_hash
$$;

CREATE FUNCTION api_token_find(p_token_hash bytea)
RETURNS TABLE (
  id uuid, tenant_id uuid, name text, scopes text[], expires_at timestamptz,
  revoked_at timestamptz, tenant_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.id, k.tenant_id, k.name, k.scopes, k.expires_at, k.revoked_at, t.status
    FROM api_tokens k
    JOIN tenants t ON t.id = k.tenant_id
   WHERE k.token_hash = p_token_hash
$$;

-- Captura trabalhos prontos de qualquer empresa. O trabalhador executa cada um no contexto da empresa dona.
CREATE FUNCTION jobs_claim(p_worker text, p_limit integer)
RETURNS SETOF jobs
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE jobs j
     SET status = 'running', attempts = j.attempts + 1, locked_at = now(), locked_by = p_worker
   WHERE j.id IN (
     SELECT id FROM jobs
      WHERE status = 'queued' AND run_at <= now()
      ORDER BY run_at, created_at
      LIMIT greatest(p_limit, 1)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING j.*
$$;

-- Devolve à fila (ou encerra) trabalhos cujo trabalhador parou de responder.
CREATE FUNCTION jobs_release_stale(p_timeout_seconds integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
         last_error = 'Trabalhador não concluiu no tempo limite',
         finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
         locked_at = NULL,
         locked_by = NULL,
         run_at = now()
   WHERE status = 'running' AND locked_at < now() - make_interval(secs => p_timeout_seconds);
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END $$;

-- Apenas contagens, para métricas operacionais. Não expõe conteúdo de nenhuma empresa.
CREATE FUNCTION ops_queue_stats()
RETURNS TABLE (status text, total bigint, oldest_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT j.status, count(*), coalesce(extract(epoch FROM now() - min(j.run_at)), 0)::double precision
    FROM jobs j
   WHERE j.status IN ('queued', 'running', 'dead')
   GROUP BY j.status
$$;

REVOKE ALL ON FUNCTION
  auth_find_user(text),
  auth_register_login_failure(uuid, integer, integer),
  auth_register_login_success(uuid),
  auth_find_session(bytea),
  api_token_find(bytea),
  jobs_claim(text, integer),
  jobs_release_stale(integer),
  ops_queue_stats()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  auth_find_user(text),
  auth_register_login_failure(uuid, integer, integer),
  auth_register_login_success(uuid),
  auth_find_session(bytea),
  api_token_find(bytea),
  jobs_claim(text, integer),
  jobs_release_stale(integer),
  ops_queue_stats()
TO {{app_role}};

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO {{app_role}};
