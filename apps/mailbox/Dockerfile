FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/mailbox/package.json apps/mailbox/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN corepack pnpm install --frozen-lockfile --filter @irudd-le/mailbox...

COPY apps/mailbox apps/mailbox
COPY packages/protocol packages/protocol
RUN corepack pnpm --filter @irudd-le/protocol build \
  && corepack pnpm --filter @irudd-le/mailbox build

ENV MAILBOX_DATABASE_PATH=/data/mailbox.sqlite
ENV PORT=3000
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "apps/mailbox/build/server.js"]
