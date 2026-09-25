#!/usr/bin/env bash
# One-time upgrade of an existing (pre-encryption) installation to the hardened stack:
#   new generated passwords on the existing database roles, TLS everywhere, every stored event and
#   sensitive column encrypted, the broker purged of plaintext messages, then a full verification.
# Safe to re-run. Takes an encrypted backup first.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${KUBER_HOME:-$HOME/.kuber}"
# Always: idempotent, and adds secrets introduced after the first setup (e.g. SYSTEM_DB_PASSWORD).
./scripts/secure-setup.sh >/dev/null
set -a; . "$DIR/secrets.env"; set +a
export KUBER_HOME="$DIR"

echo "1/7 stop the application"
docker compose stop core web 2>/dev/null || true

echo "2/7 set the generated passwords on the existing roles (over the container's local socket)"
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U kuber -d kuber \
  -v pg="$PG_PASSWORD" -v app="$APP_DB_PASSWORD" >/dev/null <<'SQL'
SET password_encryption = 'scram-sha-256';
ALTER ROLE kuber PASSWORD :'pg';
ALTER ROLE kuber_app PASSWORD :'app';
SQL

echo "3/7 restart postgres, nats and valkey with TLS and authentication"
./kuber up -d --build postgres nats valkey
./kuber build migrate core web tools >/dev/null
until ./kuber exec -T postgres pg_isready -U kuber -d kuber >/dev/null 2>&1; do sleep 1; done

echo "4/7 encrypt everything written before encryption existed"
./kuber run --rm tools encrypt-legacy

echo "5/7 purge plaintext messages from the broker (events live in PostgreSQL)"
./kuber run --rm tools purge-bus

echo "6/7 verify: link chains, digests, no plaintext left"
./kuber run --rm tools verify

echo "7/7 apply migrations (one-shot migrate service), then start core and web"
./kuber up --exit-code-from migrate migrate || { echo "migrate failed"; ./kuber logs --tail 80 migrate; exit 1; }
./kuber up -d core web
./scripts/backup.sh
./kuber ps
