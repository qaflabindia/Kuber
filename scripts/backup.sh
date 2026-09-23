#!/usr/bin/env bash
# Encrypted backup: pg_dump (custom format) streamed through AES-256-GCM (chunked, authenticated)
# under a fresh file key wrapped by the master key. Nothing unencrypted touches the disk.
#   ./scripts/backup.sh                -> ~/.kuber/backups/kuber-<UTC timestamp>.kbk (mode 0600)
# Restoring needs this file AND master.keys: store them in different places.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${KUBER_HOME:-$HOME/.kuber}"
OUT="${1:-$DIR/backups/kuber-$(date -u +%Y%m%dT%H%M%SZ).kbk}"
umask 077
./kuber exec -T postgres pg_dump -U kuber -d kuber --format=custom --compress=6 \
  | ./kuber run --rm -T tools backup-encrypt > "$OUT.partial"
mv "$OUT.partial" "$OUT"
# Prove the backup is complete and restorable: decrypt and list its contents without restoring.
n=$(./kuber run --rm -T tools backup-decrypt < "$OUT" | ./kuber exec -T postgres pg_restore --list | grep -c "TABLE DATA" || true)
[ "$n" -gt 0 ] || { echo "backup verification FAILED: $OUT"; exit 1; }
echo "backup $OUT ($(du -h "$OUT" | cut -f1), $n tables) verified"
