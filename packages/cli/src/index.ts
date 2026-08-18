#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { run, type CliIo } from './cli';
import { MailboxClient } from './client';

export { MailboxClient, MailboxApiError, type ChannelInspection, type MailboxClientLike, type PublicationInput } from './client';
export { run, UsageError, type CliIo, type CliWriter } from './cli';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function createProcessIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    readFile: (path) => (path === '-' ? readStdin() : readFile(path, 'utf8')),
    createClient: (mailboxUrl, secret) => new MailboxClient(mailboxUrl, secret),
  };
}

if (require.main === module) {
  void run(process.argv.slice(2), createProcessIo()).then(
    (code) => {
      process.exitCode = code;
    },
    // run() reports every anticipated failure itself; this only guards
    // against a genuinely unexpected bug so it never surfaces as a silent
    // unhandled rejection instead of a nonzero exit.
    (error: unknown) => {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
