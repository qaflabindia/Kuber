#!/usr/bin/env bash
# Upgrade a running hardened installation to the current code (identity, single-transaction commits,
# ingestion integrity, partitioned bus, lifecycle). Takes an encrypted backup first. Safe to re-run.
#   bash ./scripts/upgrade.sh [owner-name]
# Prints a one-time passkey enrolment code for owner:<owner-name> in the first tenant (default acme).
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${KUBER_HOME:-$HOME/.kuber}"
TENANT="${KUBER_TENANT:-acme}"
OWNER="${1:-${USER:-owner}}"
chmod +x kuber scripts/*.sh deploy/*.sh 2>/dev/null || true

echo "1/7 secrets (adds CORE_AUTH_SECRET if missing)"
./scripts/secure-setup.sh >/dev/null

echo "2/7 encrypted backup before upgrading"
./scripts/backup.sh

echo "3/7 build images"
./kuber build core web tools

echo "4/7 restart core (applies migrations on boot) and web"
./kuber up -d --force-recreate core web
for i in $(seq 1 90); do
  curl -sf --cacert "$DIR/certs/ca.crt" https://localhost:8080/healthz >/dev/null 2>&1 && break
  [ "$i" = 90 ] && { echo "core did not become healthy"; ./kuber logs --tail 80 core; exit 1; }
  sleep 2
done
echo "core healthy"

OPS=(./kuber run --rm -T --entrypoint "npx tsx apps/core/src/ops-cli.ts" tools)
echo "5/7 key and projection checks"
./kuber run --rm -T tools verify
"${OPS[@]}" check reporting
"${OPS[@]}" check agent
"${OPS[@]}" status

echo "6/7 owner passkey invitation for owner:$OWNER in tenant $TENANT"
./kuber run --rm -T --entrypoint "npx tsx apps/core/src/identity-cli.ts" tools invite "$TENANT" "owner:$OWNER"

echo "7/7 done"
./kuber ps
