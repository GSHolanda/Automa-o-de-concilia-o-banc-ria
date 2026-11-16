-- 0006_retention: expurgo de arquivos originais conforme a retenção configurada pela empresa.

-- Momento em que o arquivo original do lote foi removido. O lote, o hash e as estatísticas permanecem.
ALTER TABLE import_batches ADD COLUMN file_purged_at timestamptz;

-- Empresas com retenção de arquivos configurada. Devolve apenas ids: o trabalhador agenda o expurgo
-- de cada uma e o trabalho roda depois no contexto da própria empresa.
CREATE FUNCTION maintenance_retention_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.tenant_id
    FROM tenant_settings s
   WHERE jsonb_typeof(s.data -> 'imports' -> 'originalFileRetentionDays') = 'number'
   ORDER BY s.tenant_id
$$;

REVOKE ALL ON FUNCTION maintenance_retention_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance_retention_tenants() TO {{app_role}};
