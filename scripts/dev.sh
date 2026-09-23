#!/usr/bin/env bash
# Native development: infrastructure in Docker (TLS, passwords), core and web from source with
# reload, using the same master key and certificates as the containers.
#   ./scripts/dev.sh        then open http://localhost:3000
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${KUBER_HOME:-$HOME/.kuber}"
[ -f "$DIR/secrets.env" ] || ./scripts/secure-setup.sh
set -a; . "$DIR/secrets.env"; set +a

./kuber up -d postgres nats valkey
./kuber stop core web >/dev/null 2>&1 || true       # free ports 8080 and 3000 for the dev servers
pnpm install

export NODE_EXTRA_CA_CERTS="$DIR/certs/ca.crt"
export DATABASE_URL="postgres://kuber_app:${APP_DB_PASSWORD}@localhost:5432/kuber?sslmode=verify-full"
export MIGRATION_URL="postgres://kuber:${PG_PASSWORD}@localhost:5432/kuber?sslmode=verify-full"
export NATS_URL=tls://localhost:4222 NATS_TLS_CA="$DIR/certs/ca.crt"
export TLS_CERT_FILE="$DIR/certs/server.crt" TLS_KEY_FILE="$DIR/certs/server.key" KUBER_REQUIRE_TLS=true
export KUBER_MASTER_KEY_FILE="$DIR/master.keys"
export APP_ROLE=kuber_app CELL_ID=dev POLICY_DIR=./policies PORT=8080

pnpm dev & CORE=$!
(cd apps/web && CORE_URL=https://localhost:8080 pnpm dev) & WEB=$!
trap 'kill $CORE $WEB 2>/dev/null' INT TERM EXIT
echo "core https://localhost:8080 · web http://localhost:3000 · Ctrl-C stops both"
wait
