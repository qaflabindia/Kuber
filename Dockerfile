# Core service image. Runs TypeScript directly with tsx; a compiled build step can replace this later.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/eventstore/package.json packages/eventstore/
COPY packages/bus/package.json packages/bus/
COPY packages/crypto/package.json packages/crypto/
COPY modules/gl/package.json modules/gl/
COPY modules/policy/package.json modules/policy/
COPY modules/channels/package.json modules/channels/
COPY modules/agent/package.json modules/agent/
COPY modules/reporting/package.json modules/reporting/
COPY modules/ops/package.json modules/ops/
COPY apps/core/package.json apps/core/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 POLICY_DIR=/app/policies
COPY --from=deps /app /app
COPY . .
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch((process.env.TLS_CERT_FILE?'https':'http')+'://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "apps/core/src/main.ts"]
