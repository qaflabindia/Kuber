# Agent middleware image (services/agent-mw). Build context is the repository root:
#   docker build -f services/agent-mw/Dockerfile .
# Hardening: slim base, dependencies pinned in pyproject.toml, code and venv read-only for everyone,
# non-root runtime user, read-only root filesystem in compose (writable tmpfs for /tmp and the TLS key
# only), no published port, no shell tools beyond the base image.
FROM python:3.11-slim-bookworm AS build
WORKDIR /build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY services/agent-mw/pyproject.toml services/agent-mw/
COPY services/agent-mw/agentmw services/agent-mw/agentmw
COPY services/agent-mw/optimize services/agent-mw/optimize
RUN python -m venv /opt/venv && /opt/venv/bin/pip install ./services/agent-mw

FROM python:3.11-slim-bookworm
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp \
    AGENT_MW_AGENT_DIR=/app/agent AGENT_MW_PORT=8443 AGENT_MW_ENV=production
RUN useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin agentmw
COPY --from=build /opt/venv /opt/venv
# Compiled artifacts and the approval lock: the middleware loads only what the lock approves.
COPY agent /app/agent
COPY deploy/agent-mw-entrypoint.sh /app/entrypoint.sh
RUN chmod -R a+rX,go-w /opt/venv /app
# Starts as root only to copy the TLS key into a private tmpfs owned by agentmw, then drops to agentmw.
ENTRYPOINT ["sh", "/app/entrypoint.sh"]
EXPOSE 8443
HEALTHCHECK --interval=10s --timeout=3s CMD ["python", "-c", "import ssl,urllib.request,sys; c=ssl.create_default_context(cafile='/certs/ca.crt'); sys.exit(0 if urllib.request.urlopen('https://localhost:8443/healthz', context=c, timeout=2).status==200 else 1)"]
CMD ["python", "-m", "agentmw"]
