#!/usr/bin/env bash
# Native development: infrastructure in Docker (TLS, passwords), core and web from source with
# reload, using the same master key and certificates as the containers.
#   ./scripts/dev.sh        then open http://localhost:3000
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${KUBER_HOME:-$HOME/.kuber}"
./scripts/secure-setup.sh >/dev/null   # idempotent; adds secrets introduced since setup
set -a; . "$DIR/secrets.env"; set +a

./kuber up -d postgres nats valkey
./kuber stop core web >/dev/null 2>&1 || true       # free ports 8080 and 3000 for the dev servers
pnpm install

export NODE_EXTRA_CA_CERTS="$DIR/certs/ca.crt"
export DATABASE_URL="postgres://kuber_app:${APP_DB_PASSWORD}@localhost:5432/kuber?sslmode=verify-full"
# Owner connection: only for the one-shot migrate step below, never exported to the core (F14).
OWNER_URL="postgres://kuber:${PG_PASSWORD}@localhost:5432/kuber?sslmode=verify-full"
export SYSTEM_DATABASE_URL="postgres://kuber_system:${SYSTEM_DB_PASSWORD}@localhost:5432/kuber?sslmode=verify-full"
export NATS_URL=tls://localhost:4222 NATS_TLS_CA="$DIR/certs/ca.crt"
export TLS_CERT_FILE="$DIR/certs/server.crt" TLS_KEY_FILE="$DIR/certs/server.key" KUBER_REQUIRE_TLS=true
export KUBER_MASTER_KEY_FILE="$DIR/master.keys"
export CELL_ID=dev POLICY_DIR=./policies PORT=8080
# CORE_AUTH_SECRET and SESSION_SECRET come from secrets.env (both processes). Passkeys work on
# http://localhost; KUBER_DEV_SIGNIN=true ./scripts/dev.sh adds the insecure name-only sign-in.
export WEBAUTHN_ORIGIN=http://localhost:3000 WEBAUTHN_RP_ID=localhost KUBER_DEV_SIGNIN="${KUBER_DEV_SIGNIN:-false}"

# Migrations and grants as the owner, then the core starts with its own roles and only checks them.
MIGRATION_URL="$OWNER_URL" APP_ROLE=kuber_app SYSTEM_ROLE=kuber_system pnpm migrate
unset MIGRATION_URL

pnpm dev & CORE=$!
(cd apps/web && CORE_URL=https://localhost:8080 pnpm dev) & WEB=$!
trap 'kill $CORE $WEB 2>/dev/null' INT TERM EXIT
echo "core https://localhost:8080 · web http://localhost:3000 · Ctrl-C stops both"
wait
