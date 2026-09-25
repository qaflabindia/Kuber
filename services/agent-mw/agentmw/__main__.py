"""Start the middleware: `python -m agentmw` (or `agent-mw`).

Refuses to start without AGENT_MW_SECRET (32+ characters), with a malformed processing decision, or
without TLS (AGENT_MW_TLS_CERT / AGENT_MW_TLS_KEY) unless AGENT_MW_ALLOW_PLAINTEXT=true outside
production. An unset processing decision is allowed: the service starts and refuses model calls (503).
"""
from __future__ import annotations

import logging
import os
import sys


def main() -> None:
    logging.basicConfig(level=os.environ.get("AGENT_MW_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    from .config import Settings
    from .gate import parse_processing_approval
    s = Settings.from_env()
    if not s.secret or len(s.secret) < 32:
        sys.exit("agent-mw: AGENT_MW_SECRET must be set (at least 32 characters); run scripts/secure-setup.sh")
    g = parse_processing_approval(s.processing_approved)
    if g.configured and not g.ok:
        sys.exit(f"agent-mw: {g.reason}")
    if not g.ok:
        logging.getLogger("agentmw").warning("model processing not approved: every model endpoint answers 503")
    cert, key = os.environ.get("AGENT_MW_TLS_CERT"), os.environ.get("AGENT_MW_TLS_KEY")
    plaintext = os.environ.get("AGENT_MW_ALLOW_PLAINTEXT") == "true" and os.environ.get("AGENT_MW_ENV", "production") != "production"
    if not (cert and key) and not plaintext:
        sys.exit("agent-mw: TLS is required (AGENT_MW_TLS_CERT and AGENT_MW_TLS_KEY)")
    import uvicorn
    from .app import create_app
    uvicorn.run(create_app(s), host=os.environ.get("AGENT_MW_HOST", "0.0.0.0"), port=int(os.environ.get("AGENT_MW_PORT", "8443")),
                ssl_certfile=cert if not plaintext else None, ssl_keyfile=key if not plaintext else None,
                proxy_headers=False, server_header=False, date_header=False, access_log=False,
                limit_concurrency=64, timeout_keep_alive=5)


if __name__ == "__main__":
    main()
