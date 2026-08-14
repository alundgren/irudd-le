import { createMailbox } from './index';

const databasePath = process.env.MAILBOX_DATABASE_PATH ?? '/data/mailbox.sqlite';
const bearerToken = process.env.MAILBOX_BEARER_TOKEN;
const port = Number(process.env.PORT ?? 3000);

if (!bearerToken) {
  throw new Error('MAILBOX_BEARER_TOKEN must be configured.');
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const mailbox = createMailbox({ databasePath, bearerToken });
void mailbox.listen(port).then(({ port: boundPort }) => {
  console.log(`Mailbox listening on ${boundPort}.`);
});

const close = (): void => {
  void mailbox.close().then(() => process.exit(0));
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
