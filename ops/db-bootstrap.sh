#!/usr/bin/env bash
# Cria os papéis e o banco de dados do Concilia. Execute uma vez por instalação, como superusuário do PostgreSQL.
#
# Variáveis:
#   PGHOST, PGPORT, PGUSER, PGPASSWORD   conexão de administrador (padrões do psql)
#   DB_NAME            nome do banco             (padrão: concilia)
#   DB_OWNER_ROLE      papel dono do esquema     (padrão: concilia_owner)  — usado só para migrações
#   DB_OWNER_PASSWORD  senha do papel dono       (obrigatória)
#   DB_APP_ROLE        papel da aplicação        (padrão: concilia_app)    — sujeito a RLS
#   DB_APP_PASSWORD    senha do papel da aplicação (obrigatória)
set -euo pipefail

DB_NAME="${DB_NAME:-concilia}"
DB_OWNER_ROLE="${DB_OWNER_ROLE:-concilia_owner}"
DB_APP_ROLE="${DB_APP_ROLE:-concilia_app}"
: "${DB_OWNER_PASSWORD:?defina DB_OWNER_PASSWORD}"
: "${DB_APP_PASSWORD:?defina DB_APP_PASSWORD}"

psql -v ON_ERROR_STOP=1 --dbname postgres \
  -v owner="$DB_OWNER_ROLE" -v owner_password="$DB_OWNER_PASSWORD" \
  -v app="$DB_APP_ROLE" -v app_password="$DB_APP_PASSWORD" -v dbname="$DB_NAME" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEROLE CREATEDB', :'owner', :'owner_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'owner', :'owner_password') \gexec

-- O papel da aplicação não é dono de nada e não pode ignorar RLS.
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB', :'app', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'app', :'app_password') \gexec

SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8''', :'dbname', :'owner')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbname') \gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'dbname') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'dbname', :'app') \gexec
SQL

echo "Banco '$DB_NAME' pronto. Dono: $DB_OWNER_ROLE. Aplicação: $DB_APP_ROLE."
echo "Próximo passo: pnpm db:migrate"
