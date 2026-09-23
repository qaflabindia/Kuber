#!/usr/bin/env bash
# Run the test suite against the Docker PostgreSQL over TLS (sslmode=verify-full).
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${KUBER_HOME:-$HOME/.kuber}"
set -a; . "$DIR/secrets.env"; set +a
export NODE_EXTRA_CA_CERTS="$DIR/certs/ca.crt"
export TEST_DATABASE_ADMIN_URL="postgres://kuber:${PG_PASSWORD}@localhost:5432/postgres?sslmode=verify-full"
export TEST_APP_DB_PASSWORD="$APP_DB_PASSWORD"
export TEST_SYSTEM_DB_PASSWORD="${SYSTEM_DB_PASSWORD:-kuber_system}"
exec npx vitest run "$@"
