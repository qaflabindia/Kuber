#!/usr/bin/env bash
# Run the live LLM classifier test against the Anthropic API. Needs ANTHROPIC_API_KEY and
# a model (default claude-sonnet-5), from the environment or $KUBER_HOME/secrets.env.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${KUBER_HOME:-$HOME/.kuber}"
[ -f "$DIR/secrets.env" ] && { set -a; . "$DIR/secrets.env"; set +a; }
# Or take the key from a notes file: the first sk-ant-… token in $KUBER_ANTHROPIC_KEY_FILE.
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -n "${KUBER_ANTHROPIC_KEY_FILE:-}" ]; then
  ANTHROPIC_API_KEY="$(grep -oE 'sk-ant-[A-Za-z0-9_-]+' "$KUBER_ANTHROPIC_KEY_FILE" | head -1 || true)"
  [ -n "$ANTHROPIC_API_KEY" ] || { echo "no sk-ant- key found in $KUBER_ANTHROPIC_KEY_FILE" >&2; exit 1; }
  export ANTHROPIC_API_KEY
fi
export KUBER_LLM_CLASSIFY_MODEL="${KUBER_LLM_CLASSIFY_MODEL:-${KUBER_LLM_MODEL:-claude-sonnet-5}}"
# Talk to the public API unless a base URL is given for Kuber explicitly.
unset ANTHROPIC_BASE_URL
[ -n "${KUBER_ANTHROPIC_BASE_URL:-}" ] && export ANTHROPIC_BASE_URL="$KUBER_ANTHROPIC_BASE_URL"
exec npx vitest run tests/live "$@"
