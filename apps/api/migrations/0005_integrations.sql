-- 0005_integrations: sugestões de IA, idempotência da API de entrada de lançamentos e consulta de regras de aviso.

-- Sugestão de classificação produzida por provedor de IA: identificada como tal, nunca confirmada sozinha.
ALTER TABLE matches DROP CONSTRAINT matches_origin_check;
ALTER TABLE matches ADD CONSTRAINT matches_origin_check CHECK (origin IN ('engine', 'user', 'ai'));

-- Lote recebido pela API: a mesma chave de idempotência devolve o mesmo lote.
ALTER TABLE import_batches
  ADD COLUMN idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
  ADD COLUMN api_token_id uuid,
  ADD COLUMN integration_id uuid,
  ADD CONSTRAINT import_batches_api_token_fk FOREIGN KEY (tenant_id, api_token_id) REFERENCES api_tokens (tenant_id, id),
  ADD CONSTRAINT import_batches_integration_fk FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations (tenant_id, id);
CREATE UNIQUE INDEX import_batches_idempotency ON import_batches (tenant_id, origin, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX notification_rules_event ON notification_rules (tenant_id, event) WHERE active;
CREATE INDEX matches_origin_open ON matches (tenant_id, origin, status) WHERE origin = 'ai';
