#!/usr/bin/env bash
# Gera um backup do banco do Concilia em formato custom do pg_dump.
#
# Uso: ops/backup.sh
#
# Variáveis:
#   MIGRATION_DATABASE_URL  conexão usada para o backup (ou BACKUP_DATABASE_URL, se definida)
#   BACKUP_DATABASE_URL     conexão de backup, tem prioridade sobre MIGRATION_DATABASE_URL
#
# Saída: backups/concilia-AAAAMMDD-HHMMSS.dump na raiz do projeto, com o caminho e o SHA-256 impressos.
# Requer pg_dump e sha256sum (ou shasum) instalados.
set -euo pipefail

DATABASE_URL="${BACKUP_DATABASE_URL:-${MIGRATION_DATABASE_URL:-}}"
if [ -z "$DATABASE_URL" ]; then
  echo "defina MIGRATION_DATABASE_URL ou BACKUP_DATABASE_URL" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/backups"
mkdir -p "$OUT_DIR"

OUT_FILE="$OUT_DIR/concilia-$(date +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --file "$OUT_FILE" "$DATABASE_URL"

if command -v sha256sum >/dev/null 2>&1; then
  HASH="$(sha256sum "$OUT_FILE" | cut -d' ' -f1)"
else
  HASH="$(shasum -a 256 "$OUT_FILE" | cut -d' ' -f1)"
fi

echo "Backup gerado: $OUT_FILE"
echo "SHA-256: $HASH"
