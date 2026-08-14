# syntax=docker/dockerfile:1.7

# Build the mailbox and its workspace dependency (@irudd-le/protocol),
# then produce a self-contained deployable folder via `pnpm deploy`.
FROM node:24-slim AS builder
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/mailbox ./apps/mailbox
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @irudd-le/protocol build \
 && corepack pnpm --filter @irudd-le/mailbox build
RUN corepack pnpm --filter @irudd-le/mailbox deploy --prod /deploy --config.inject-workspace-packages=true
RUN rm -f /deploy/build/*.test.js /deploy/build/*.test.js.map /deploy/build/*.test.d.ts

# Runtime image: just Node.js + the deployed mailbox.
FROM node:24-slim AS runtime
LABEL org.opencontainers.image.title="irudd-le mailbox"
LABEL org.opencontainers.image.source="https://github.com/alundgren/irudd-le"
LABEL org.opencontainers.image.description="Durable SQLite-backed mailbox and canonical HTTP API for the Last Epoch content shell"
WORKDIR /app
ENV MAILBOX_DATABASE_PATH=/var/lib/mailbox/mailbox.db \
    MAILBOX_LISTEN_HOST=0.0.0.0 \
    MAILBOX_LISTEN_PORT=8080 \
    NODE_ENV=production
COPY --from=builder /deploy ./
RUN mkdir -p /var/lib/mailbox \
 && chown -R node:node /app /var/lib/mailbox
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAILBOX_LISTEN_PORT||'8080')+'/healthz').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
CMD ["node", "build/index.js"]