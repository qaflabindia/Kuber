#!/usr/bin/env bash
# Restore an encrypted backup. By default into a NEW database (kuber_restore_<time>) so a mistake
# never overwrites live data; --replace restores over the live database after confirmation.
#   ./scripts/restore.sh ~/.kuber/backups/kuber-....kbk [--replace]
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?usage: scripts/restore.sh <backup.kbk> [--replace]}"
if [ "${2:-}" = "--replace" ]; then
  read -r -p "Replace the LIVE database with $FILE? Type 'replace' to continue: " ok
  [ "$ok" = "replace" ] || { echo "aborted"; exit 1; }
  ./kuber stop core web
  DB=kuber; FLAGS="--clean --if-exists"
else
  DB="kuber_restore_$(date -u +%Y%m%d%H%M%S)"; FLAGS=""
  ./kuber exec -T postgres createdb -U kuber "$DB"
fi
./kuber run --rm -T tools backup-decrypt < "$FILE" \
  | ./kuber exec -T postgres pg_restore -U kuber -d "$DB" --no-owner --role=kuber $FLAGS --exit-on-error
if [ "$DB" = kuber ]; then
  # A backup taken before a crypto-shred still holds that tenant's wrapped keys: erase it again
  # from the shred ledger (~/.kuber/shredded.jsonl) before anything can read it.
  ./kuber run --rm -T tools reapply-shreds
  ./kuber start core web
else
  echo "NOTE: before using $DB, run: keys reapply-shreds (with MIGRATION_URL pointing at $DB) so erased tenants stay erased"
fi
echo "restored into database $DB"
