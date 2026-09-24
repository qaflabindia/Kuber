# Web (SvelteKit BFF) image. Build context is the repository root: docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
RUN pnpm install --frozen-lockfile --filter @kuber/web...
COPY apps/web apps/web
COPY packages/auth packages/auth
# adapter-node bundles server code; fonts are compiled into client assets, so the runtime needs no node_modules.
RUN cd apps/web && npx svelte-kit sync && npx vite build && mkdir -p /out && cp -r build package.json /out/

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 BODY_SIZE_LIMIT=3M
COPY --from=build /out /app
RUN chmod -R a+rX,go-w /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://localhost:3000/signin').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build"]
