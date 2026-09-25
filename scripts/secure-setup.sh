#!/usr/bin/env bash
# Creates what Kuber needs to run encrypted and over TLS, OUTSIDE the repository:
#   ~/.kuber/master.keys    master key (AES-256), mode 0600: unlocks every tenant's data keys
#   ~/.kuber/secrets.env    database (owner, app, system), broker and cache passwords, session secret,
#                           CORE_AUTH_SECRET (web signs every request to the core with it),
#                           AGENT_MW_SECRET (core signs every request to the agent middleware with it), mode 0600
#   ~/.kuber/certs/         local CA, one service certificate (postgres, nats, core, valkey, web) and the
#                           agent middleware's own certificate (agent-mw.crt / agent-mw.key)
# Idempotent: existing files are kept. `--rotate-certs` issues new certificates.
# Back up master.keys separately from database backups: one without the other is useless.
set -euo pipefail
DIR="${KUBER_HOME:-$HOME/.kuber}"
umask 077
command -v openssl >/dev/null || { echo "openssl is required"; exit 1; }
mkdir -p "$DIR/certs" "$DIR/backups"
chmod 700 "$DIR" "$DIR/certs" "$DIR/backups"

if [ ! -f "$DIR/master.keys" ]; then
  id="kek-$(date +%Y%m%d)-$(openssl rand -hex 3)"
  printf '{\n  "format": "kuber-keys/1",\n  "active": "%s",\n  "keys": { "%s": "%s" }\n}\n' "$id" "$id" "$(openssl rand -base64 32)" > "$DIR/master.keys"
  chmod 600 "$DIR/master.keys"
  echo "created master key $id"
fi

if [ ! -f "$DIR/secrets.env" ]; then
  {
    echo "PG_PASSWORD=$(openssl rand -hex 24)"
    echo "APP_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "NATS_TOKEN=$(openssl rand -hex 24)"
    echo "VALKEY_PASSWORD=$(openssl rand -hex 24)"
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
  } > "$DIR/secrets.env"
  chmod 600 "$DIR/secrets.env"
  echo "created secrets.env"
fi
# Secrets added in later versions: appended to an existing secrets.env, never overwritten.
for k in SYSTEM_DB_PASSWORD CORE_AUTH_SECRET AGENT_MW_SECRET; do
  grep -q "^$k=" "$DIR/secrets.env" || { echo "$k=$(openssl rand -hex 24)" >> "$DIR/secrets.env"; echo "added $k to secrets.env"; }
done

C="$DIR/certs"
if [ ! -f "$C/server.crt" ] || [ "${1:-}" = "--rotate-certs" ]; then
  cat > "$C/openssl.cnf" <<'CNF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = Kuber local CA
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[v3_srv]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = DNS:postgres, DNS:nats, DNS:core, DNS:valkey, DNS:web, DNS:localhost, IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF
  if [ ! -f "$C/ca.key" ] || [ "${1:-}" = "--rotate-certs" ]; then
    openssl ecparam -name prime256v1 -genkey -noout -out "$C/ca.key"
    openssl req -x509 -new -key "$C/ca.key" -sha256 -days 1825 -config "$C/openssl.cnf" -extensions v3_ca -out "$C/ca.crt"
  fi
  openssl ecparam -name prime256v1 -genkey -noout -out "$C/server.key"
  openssl req -new -key "$C/server.key" -subj "/CN=kuber-services" -out "$C/server.csr"
  openssl x509 -req -in "$C/server.csr" -CA "$C/ca.crt" -CAkey "$C/ca.key" -CAcreateserial -days 825 -sha256 \
    -extfile "$C/openssl.cnf" -extensions v3_srv -out "$C/server.crt" 2>/dev/null
  rm -f "$C/server.csr" "$C/ca.srl"
  chmod 600 "$C/ca.key" "$C/server.key"; chmod 644 "$C/ca.crt" "$C/server.crt"
  openssl verify -CAfile "$C/ca.crt" "$C/server.crt"
fi

# Agent middleware: its own key and certificate from the same CA (made the way the core's is), so its
# key is not shared with the services that hold data. Issued when missing, re-issued with --rotate-certs
# or after the CA changed.
if [ ! -f "$C/agent-mw.crt" ] || [ "${1:-}" = "--rotate-certs" ] || ! openssl verify -CAfile "$C/ca.crt" "$C/agent-mw.crt" >/dev/null 2>&1; then
  cat > "$C/agent-mw.cnf" <<'CNF'
[v3_agentmw]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:agent-mw, DNS:localhost, IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF
  openssl ecparam -name prime256v1 -genkey -noout -out "$C/agent-mw.key"
  openssl req -new -key "$C/agent-mw.key" -subj "/CN=kuber-agent-mw" -out "$C/agent-mw.csr"
  openssl x509 -req -in "$C/agent-mw.csr" -CA "$C/ca.crt" -CAkey "$C/ca.key" -CAcreateserial -days 825 -sha256 \
    -extfile "$C/agent-mw.cnf" -extensions v3_agentmw -out "$C/agent-mw.crt" 2>/dev/null
  rm -f "$C/agent-mw.csr" "$C/ca.srl"
  chmod 600 "$C/agent-mw.key"; chmod 644 "$C/agent-mw.crt"
  openssl verify -CAfile "$C/ca.crt" "$C/agent-mw.crt"
fi
echo "Kuber secrets are in $DIR. Start the stack with ./kuber up -d --build"
