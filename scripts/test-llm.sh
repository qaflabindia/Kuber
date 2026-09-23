#!/usr/bin/env bash
# Run the live LLM classifier test against the Anthropic API. Needs ANTHROPIC_API_KEY and
# KUBER_LLM_CLASSIFY_MODEL (or KUBER_LLM_MODEL), from the environment or $KUBER_HOME/secrets.env.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${KUBER_HOME:-$HOME/.kuber}"
[ -f "$DIR/secrets.env" ] && { set -a; . "$DIR/secrets.env"; set +a; }
# Talk to the public API unless a base URL is given for Kuber explicitly.
unset ANTHROPIC_BASE_URL
[ -n "${KUBER_ANTHROPIC_BASE_URL:-}" ] && export ANTHROPIC_BASE_URL="$KUBER_ANTHROPIC_BASE_URL"
exec npx vitest run tests/live "$@"
