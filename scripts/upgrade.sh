#!/usr/bin/env bash
# Upgrade a running hardened installation to the current code (identity, single-transaction commits,
# ingestion integrity, partitioned bus, lifecycle). Takes an encrypted backup first. Safe to re-run.
#   bash ./scripts/upgrade.sh [--invite <name> | --recover <role:name>]
# With --recover, issues an audited one-time recovery code for an existing member who lost access
# (their old passkeys are revoked when the code is redeemed).
# With --invite, prints a one-time passkey enrolment code for superuser:<name> in the tenant (default acme).
# Existing members keep their passkeys; role model v2 migrates their roles at core start (owner -> superuser).
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${KUBER_HOME:-$HOME/.kuber}"
TENANT="${KUBER_TENANT:-acme}"
INVITE=""; RECOVER=""
[ "${1:-}" = "--invite" ] && INVITE="${2:?--invite needs a name}"
[ "${1:-}" = "--recover" ] && RECOVER="${2:?--recover needs a principal, e.g. owner:laksh}"
chmod +x kuber scripts/*.sh deploy/*.sh 2>/dev/null || true

echo "1/7 secrets (adds CORE_AUTH_SECRET if missing)"
./scripts/secure-setup.sh >/dev/null

echo "2/7 encrypted backup before upgrading"
./scripts/backup.sh

echo "3/7 build images"
./kuber build migrate core web tools

echo "4/7 apply migrations (one-shot migrate service, owner credentials), then restart core and web"
./kuber up --force-recreate --exit-code-from migrate migrate || { echo "migrate failed"; ./kuber logs --tail 80 migrate; exit 1; }
./kuber up -d --force-recreate core web
for i in $(seq 1 90); do
  curl -sf --cacert "$DIR/certs/ca.crt" https://localhost:8080/healthz >/dev/null 2>&1 && break
  [ "$i" = 90 ] && { echo "core did not become healthy"; ./kuber logs --tail 80 core; exit 1; }
  sleep 2
done
echo "core healthy"
# Events reach the modules (reporting, evidence, agent) only through the outbox relay; a stuck relay leaves
# every statement at its last projected position. Wait for it to publish, and stop with a clear message if not.
sleep 3   # let the relay attempt its first batches
for i in $(seq 1 30); do
  curl -sf --cacert "$DIR/certs/ca.crt" https://localhost:8080/healthz | grep -q '"relay":{"ok":true' && { echo "event relay publishing"; break; }
  [ "$i" = 30 ] && { echo "event relay is failing: modules are not receiving events (see: ./kuber logs --tail 50 core | grep relay)"; exit 1; }
  sleep 2
done

OPS=(./kuber run --rm -T --entrypoint "npx tsx apps/core/src/ops-cli.ts" tools)
echo "5/7 key and projection checks"
./kuber run --rm -T tools verify
"${OPS[@]}" check reporting
"${OPS[@]}" check agent
"${OPS[@]}" status

IDCLI=(./kuber run --rm -T --entrypoint "npx tsx apps/core/src/identity-cli.ts" tools)
if [ -n "$RECOVER" ]; then
  echo "6/7 account recovery for $RECOVER in tenant $TENANT"
  "${IDCLI[@]}" recover "$TENANT" "$RECOVER" --reason "lost access to passkey (operator upgrade.sh --recover)" --hours 24
elif [ -n "$INVITE" ]; then
  echo "6/7 passkey invitation for superuser:$INVITE in tenant $TENANT"
  "${IDCLI[@]}" invite "$TENANT" "superuser:$INVITE"
else
  echo "6/7 members of $TENANT after the role migration (no invitation requested)"
  "${IDCLI[@]}" members "$TENANT" || true
fi

echo "7/7 done"
./kuber ps
