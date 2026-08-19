# syntax=docker/dockerfile:1.7

# Build this image from the repository root so the MCP package can consume the
# shared protocol workspace without copying the mailbox application.
FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS builder
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/mcp ./packages/mcp
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @irudd-le/protocol build \
 && corepack pnpm --filter @irudd-le/mcp build
RUN corepack pnpm --filter @irudd-le/mcp deploy --prod /deploy --config.inject-workspace-packages=true
RUN rm -f /deploy/build/*.test.js /deploy/build/*.test.js.map /deploy/build/*.test.d.ts

FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime
LABEL org.opencontainers.image.title="irudd-le mailbox MCP service"
LABEL org.opencontainers.image.source="https://github.com/alundgren/irudd-le"
LABEL org.opencontainers.image.description="Stateless private MCP adapter for the irudd-le mailbox"
WORKDIR /app
ENV MCP_LISTEN_HOST=0.0.0.0 \
    MCP_LISTEN_PORT=8081 \
    NODE_ENV=production
COPY --from=builder /deploy ./
RUN chown -R node:node /app
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_LISTEN_PORT||'8081')+'/healthz').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
CMD ["node", "build/index.js"]
