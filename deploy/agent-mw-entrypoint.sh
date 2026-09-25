#!/bin/sh
# Agent middleware: start as root only long enough to copy the TLS key (host-owned, mode 0600) into a
# private tmpfs owned by the runtime user, then drop privileges for good (as deploy/core-entrypoint.sh).
set -eu
if [ "$(id -u)" = "0" ]; then
  install -d -o agentmw -g agentmw -m 700 /run/agent-mw
  install -o agentmw -g agentmw -m 600 /certs/agent-mw.key /run/agent-mw/tls.key
  exec setpriv --reuid=agentmw --regid=agentmw --init-groups --no-new-privs "$@"
fi
exec "$@"
