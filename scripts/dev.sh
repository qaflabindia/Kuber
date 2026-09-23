#!/usr/bin/env bash
# Native development on this machine: infrastructure in Docker, core and web from source with reload.
#   ./scripts/dev.sh        then open http://localhost:3000
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d postgres nats valkey
docker compose stop core web >/dev/null 2>&1 || true      # free ports 8080 and 3000 for the dev servers
pnpm install

export DATABASE_URL=postgres://kuber_app:kuber_app@localhost:5432/kuber
export MIGRATION_URL=postgres://kuber:kuber@localhost:5432/kuber
export APP_ROLE=kuber_app NATS_URL=nats://localhost:4222 CELL_ID=dev POLICY_DIR=./policies PORT=8080

pnpm dev & CORE=$!
(cd apps/web && CORE_URL=http://localhost:8080 pnpm dev) & WEB=$!
trap 'kill $CORE $WEB 2>/dev/null' INT TERM EXIT
echo "core http://localhost:8080 · web http://localhost:3000 · Ctrl-C stops both"
wait
