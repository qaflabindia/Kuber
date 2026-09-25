#!/usr/bin/env bash
# FIN-OPS-01 restore drill: prove the latest encrypted backup restores into a working, identical cell.
#
#   ./scripts/restore-drill.sh [backup.kbk] [--keep]
#
# 1. restores the backup (default: the newest ~/.kuber/backups/*.kbk) into a throwaway database
#    kuber_drill_<time> on the same PostgreSQL server; the live database is never touched
# 2. re-applies recorded crypto-shreds, so erased tenants stay erased
# 3. rebuilds the reporting, agent and evidence projections from the restored events
# 4. runs `keys verify --full` and `ops check reporting|agent|evidence`
# 5. compares balances, open drafts, match reviews, open plans, certified snapshots (and events,
#    evidence balances, open incidents) against the live database, per tenant
# 6. prints the elapsed time and writes JSON evidence to ~/.kuber/drills/drill-<time>.json
# 7. drops the drill database (unless --keep)
#
# Isolation: every step runs in the tools container against the drill database only, with the
# in-memory bus and no relay (as `ops` always runs), and NATS_URL cleared: nothing is published to
# the bus and no external action is taken. For an exact comparison run it when the live cell is
# quiet, or right after ./scripts/backup.sh; differences written after the backup show up as such.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${KUBER_HOME:-$HOME/.kuber}"
BACKUP=""; KEEP=false
for a in "$@"; do case "$a" in --keep) KEEP=true ;; *) BACKUP="$a" ;; esac; done
[ -n "$BACKUP" ] || BACKUP="$(ls -1t "$DIR"/backups/*.kbk 2>/dev/null | head -1 || true)"
[ -n "$BACKUP" ] && [ -f "$BACKUP" ] || { echo "no backup found (looked in $DIR/backups); run ./scripts/backup.sh first"; exit 1; }
[ -f "$DIR/secrets.env" ] || { echo "no $DIR/secrets.env; run ./scripts/secure-setup.sh"; exit 1; }
# shellcheck disable=SC1091
set -a; . "$DIR/secrets.env"; set +a

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB="kuber_drill_$(date -u +%Y%m%d%H%M%S)"
mkdir -p "$DIR/drills"; chmod 700 "$DIR/drills"
EVIDENCE="drills/drill-$STAMP.json"               # relative to KUBER_HOME, mounted at /kuber in the tools container
START=$(date +%s); STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PGQ="sslmode=verify-full"
OWNER_URL="postgres://kuber:${PG_PASSWORD}@postgres:5432/$DB?$PGQ"
APP_URL="postgres://kuber_app:${APP_DB_PASSWORD}@postgres:5432/$DB?$PGQ"
SYS_URL="postgres://kuber_system:${SYSTEM_DB_PASSWORD}@postgres:5432/$DB?$PGQ"
LIVE_URL="postgres://kuber:${PG_PASSWORD}@postgres:5432/kuber?$PGQ"

cleanup() {
  if [ "$KEEP" = true ]; then echo "kept drill database $DB"
  else ./kuber exec -T postgres dropdb -U kuber --if-exists --force "$DB" >/dev/null 2>&1 || echo "WARNING: could not drop $DB"; fi
}
trap cleanup EXIT

# Everything below talks to the drill database only; NATS_URL is cleared so nothing can reach the bus.
tools() {
  ./kuber run --rm -T -e DATABASE_URL="$APP_URL" -e MIGRATION_URL="$OWNER_URL" -e SYSTEM_DATABASE_URL="$SYS_URL" \
    -e NATS_URL= -e NATS_TOKEN= -e KUBER_DRILL=1 tools "$@"
}
declare -A STEP
step() {                                           # step <name> <command...>: run, record its exit status
  local name="$1"; shift
  echo "== $name"
  if "$@"; then STEP[$name]=0; else STEP[$name]=$?; echo "   FAILED ($name: exit ${STEP[$name]})"; fi
}

echo "restore drill: $BACKUP -> database $DB"
step create ./kuber exec -T postgres createdb -U kuber "$DB"
restore() { ./kuber run --rm -T tools backup-decrypt < "$BACKUP" | ./kuber exec -T postgres pg_restore -U kuber -d "$DB" --no-owner --role=kuber --exit-on-error; }
step restore restore
[ "${STEP[restore]}" = 0 ] || { echo "restore failed; see above"; exit 1; }
step reapply_shreds tools reapply-shreds
for p in reporting agent evidence; do step "rebuild_$p" tools ops rebuild "$p"; done
step keys_verify_full tools verify --full
for p in reporting agent evidence; do step "check_$p" tools ops check "$p"; done

ELAPSED=$(( $(date +%s) - START ))
META="{\"backup\":\"$(basename "$BACKUP")\",\"backupBytes\":$(wc -c < "$BACKUP" | tr -d ' '),\"backupSha256\":\"$(sha256sum "$BACKUP" | cut -d' ' -f1)\""
META="$META,\"database\":\"$DB\",\"startedAt\":\"$STARTED_AT\",\"elapsedSecondsBeforeCompare\":$ELAPSED,\"steps\":{"
first=true
for k in create restore reapply_shreds rebuild_reporting rebuild_agent rebuild_evidence keys_verify_full check_reporting check_agent check_evidence; do
  $first || META="$META,"; first=false; META="$META\"$k\":${STEP[$k]:-null}"
done
META="$META}}"
step compare tools ops drill-compare --source "$LIVE_URL" --restored "$OWNER_URL" --out "/kuber/$EVIDENCE" --meta "$META"

ELAPSED=$(( $(date +%s) - START ))
FAILED=""
for k in "${!STEP[@]}"; do [ "${STEP[$k]}" = 0 ] || FAILED="$FAILED $k"; done
echo "restore drill finished in ${ELAPSED}s; evidence: $DIR/$EVIDENCE"
if [ -n "$FAILED" ]; then echo "DRILL FAILED:$FAILED"; exit 1; fi
echo "DRILL PASSED: restored cell matches the source"
