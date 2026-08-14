FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/mailbox ./apps/mailbox
RUN corepack enable && pnpm install --frozen-lockfile && pnpm --filter @irudd-le/protocol build && pnpm --filter @irudd-le/mailbox build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV MAILBOX_DATABASE_PATH=/var/lib/mailbox/mailbox.sqlite
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol ./packages/protocol
COPY --from=build /app/apps/mailbox/node_modules ./apps/mailbox/node_modules
COPY --from=build /app/apps/mailbox/build ./apps/mailbox/build
EXPOSE 3000
VOLUME ["/var/lib/mailbox"]
CMD ["node", "apps/mailbox/build/index.js"]
