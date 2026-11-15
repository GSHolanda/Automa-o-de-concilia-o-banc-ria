#!/usr/bin/env bash
# Restaura um backup do Concilia (gerado por ops/backup.sh) em um banco de destino.
# ATENÇÃO: --clean apaga os objetos existentes no destino antes de recriá-los.
#
# Uso: CONFIRM=sim RESTORE_DATABASE_URL=postgres://... ops/restore.sh backups/concilia-AAAAMMDD-HHMMSS.dump
#
# Variáveis:
#   RESTORE_DATABASE_URL  banco de destino (obrigatória)
#   CONFIRM=sim           obrigatória para executar; sem ela o script só recusa
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "uso: CONFIRM=sim RESTORE_DATABASE_URL=... $0 <arquivo.dump>" >&2
  exit 1
fi

DUMP_FILE="$1"
: "${RESTORE_DATABASE_URL:?defina RESTORE_DATABASE_URL com o banco de destino}"

if [ ! -f "$DUMP_FILE" ]; then
  echo "arquivo não encontrado: $DUMP_FILE" >&2
  exit 1
fi

if [ "${CONFIRM:-}" != "sim" ]; then
  echo "restauração recusada: defina CONFIRM=sim para confirmar que o destino pode ser sobrescrito" >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --exit-on-error --dbname "$RESTORE_DATABASE_URL" "$DUMP_FILE"
echo "Restauração concluída a partir de: $DUMP_FILE"
