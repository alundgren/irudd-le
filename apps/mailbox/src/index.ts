import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { PROTOCOL_VERSION, protocolEnvelopeSchema } from '@irudd-le/protocol';
import { createMailbox, DEFAULT_MAX_BODY_BYTES, type Mailbox, type MailboxOptions } from './mailbox';

export { PROTOCOL_VERSION, protocolEnvelopeSchema };
export { createMailbox, DEFAULT_MAX_BODY_BYTES } from './mailbox';
export type { Mailbox, MailboxOptions } from './mailbox';

const DEFAULT_DATABASE_PATH = process.env.MAILBOX_DATABASE_PATH ?? './data/mailbox.db';
const DEFAULT_LISTEN_HOST = process.env.MAILBOX_LISTEN_HOST ?? '0.0.0.0';
const DEFAULT_LISTEN_PORT = Number(process.env.MAILBOX_LISTEN_PORT ?? '8080');
const ENV_MAX_BODY_BYTES = Number(process.env.MAILBOX_MAX_BODY_BYTES ?? String(DEFAULT_MAX_BODY_BYTES));

if (require.main === module) {
  const tokens = (process.env.MAILBOX_BEARER_TOKENS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    console.error('MAILBOX_BEARER_TOKENS is required (comma-separated tokens)');
    process.exit(1);
  }
  const databasePath = DEFAULT_DATABASE_PATH;
  const dataDir = path.dirname(databasePath);
  if (dataDir && dataDir !== '.') mkdirSync(dataDir, { recursive: true });
  const options: MailboxOptions = {
    databasePath,
    bearerTokens: tokens,
    listen: { host: DEFAULT_LISTEN_HOST, port: DEFAULT_LISTEN_PORT },
    maxBodyBytes: Number.isFinite(ENV_MAX_BODY_BYTES) ? ENV_MAX_BODY_BYTES : undefined,
  };
  let mailbox: Mailbox | undefined;
  const shutdown = (): void => {
    if (!mailbox) return;
    void mailbox.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  mailbox = createMailbox(options);
  mailbox
    .start()
    .then(() => {
      console.log(`mailbox listening on ${options.listen.host}:${options.listen.port} (${options.databasePath})`);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}