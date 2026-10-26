# syntax=docker/dockerfile:1
# Use a tested image digest when promoting a release to production.
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN npm install --global pnpm@10.4.1
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/

FROM dependencies AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM dependencies AS production-dependencies
RUN pnpm install --prod --frozen-lockfile

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3037 \
    LIVE_SEND_ENABLED=false \
    DATABASE_SSL=verify-full \
    PATH=/usr/lib/postgresql/17/bin:$PATH
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates postgresql-client-17 tini \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /app/.runtime
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/drizzle/0000_massive_chamber.sql ./drizzle/0000_massive_chamber.sql
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/scripts/run.mjs ./scripts/run.mjs
COPY --from=build --chown=node:node /app/scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh
# Windows checkouts may carry CRLF. Keep the runtime entrypoint valid on Linux.
RUN sed -i 's/\r$//' /app/scripts/container-entrypoint.sh \
    && chmod 0555 /app/scripts/container-entrypoint.sh \
    && pg_dump --version \
    && pg_restore --version
USER node
EXPOSE 3037
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=6s --start-period=90s --retries=3 \
  CMD node --input-type=module -e 'try { const r = await fetch("http://127.0.0.1:" + process.env.PORT + "/readyz", { signal: AbortSignal.timeout(5000) }); const body = await r.json(); process.exit(r.ok && body.ready === true ? 0 : 1); } catch { process.exit(1); }'
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/container-entrypoint.sh"]
