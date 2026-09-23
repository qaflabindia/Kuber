#!/bin/sh
# First start of an empty volume: the application role (not superuser, not BYPASSRLS, so
# row-level security applies to it) with the generated password from ~/.kuber/secrets.env.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v pw="$APP_DB_PASSWORD" <<'SQL'
SET password_encryption = 'scram-sha-256';
CREATE ROLE kuber_app LOGIN PASSWORD :'pw' NOSUPERUSER NOBYPASSRLS;
SQL
