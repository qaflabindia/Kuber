#!/bin/sh
# Start as root only long enough to copy secrets into a private tmpfs owned by the runtime user,
# then drop privileges. Mounted files keep the host's owner and 0600 mode, which a non-root user
# inside the container may not be able to read.
set -eu
if [ "$(id -u)" = "0" ]; then
  install -d -o node -g node -m 700 /run/kuber
  install -o node -g node -m 600 /kuber/master.keys /run/kuber/master.keys
  install -o node -g node -m 600 /certs/server.key /run/kuber/server.key
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
