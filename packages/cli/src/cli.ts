import { parseArgs } from 'node:util';
import type { ChannelInspection, MailboxClientLike } from './client';
import { MailboxApiError } from './client';

export class UsageError extends Error {}

export interface CliWriter {
  write(chunk: string): void;
}

export interface CliIo {
  readonly stdout: CliWriter;
  readonly stderr: CliWriter;
  /** Operator-provided credentials arrive only through `--secret` or this env, and are never written to stdout/stderr. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => Promise<string>;
  readonly createClient: (mailboxUrl: string, secret: string) => MailboxClientLike;
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'status') return await runStatus(rest, io);
    if (command === 'publish') return await runPublish(rest, io);
    throw new UsageError(`Unknown command '${command ?? ''}'. Expected 'status' or 'publish'.`);
  } catch (error) {
    if (error instanceof MailboxApiError) {
      io.stderr.write(`Error: ${error.code}: ${error.message}\n`);
      return 1;
    }
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
    // A malformed flag, an unreadable HTML file, or a malformed --mailbox-url
    // all land here (node:util's parseArgs and node:fs throw plain Error
    // subclasses, not UsageError) -- one actionable stderr line beats a raw
    // stack trace for every one of them.
    io.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runStatus(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      'mailbox-url': { type: 'string' },
      channel: { type: 'string' },
      secret: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  const mailboxUrl = requireValue(values['mailbox-url'], '--mailbox-url');
  const channel = requireValue(values.channel, '--channel');
  const secret = resolveSecret(values.secret, io.env);
  const client = io.createClient(mailboxUrl, secret);
  const inspection = await client.inspectChannel(channel);
  io.stdout.write(formatInspection(inspection));
  return 0;
}

async function runPublish(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      'mailbox-url': { type: 'string' },
      channel: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      'html-file': { type: 'string' },
      'profile-version': { type: 'string' },
      secret: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  const mailboxUrl = requireValue(values['mailbox-url'], '--mailbox-url');
  const channel = requireValue(values.channel, '--channel');
  const title = requireValue(values.title, '--title');
  const htmlFile = requireValue(values['html-file'], '--html-file');
  const secret = resolveSecret(values.secret, io.env);
  const profileVersion = values['profile-version'] === undefined ? undefined : parsePositiveInteger(values['profile-version'], '--profile-version');
  const html = await io.readFile(htmlFile);
  const client = io.createClient(mailboxUrl, secret);
  const revision = await client.publish({ channel, title, description: values.description, html, profileVersion });
  io.stdout.write(`Published revision '${revision.id}' to channel '${revision.channel}' (profile v${revision.profileVersion}).\n`);
  return 0;
}

function formatInspection(inspection: ChannelInspection): string {
  const lines = [`Channel '${inspection.channel.id}' (${inspection.channel.name})`];
  if (inspection.state === 'unbound') {
    lines.push('Target: unbound — no target-accurate preview is available.');
    return `${lines.join('\n')}\n`;
  }
  const { profile, renderStatus } = inspection;
  lines.push(
    `Target: paired, profile v${profile.version}, ${profile.contentBox.width}x${profile.contentBox.height} content box.`
  );
  if (renderStatus === null) {
    lines.push('Render status: the paired target has not reported an observation yet.');
  } else if (renderStatus.activation === 'active') {
    lines.push(
      `Render status: active, revision '${renderStatus.currentRevisionId}', observed ${new Date(renderStatus.observedAt).toISOString()}, target ${renderStatus.online ? 'online' : 'offline'}.`
    );
  } else {
    lines.push(
      `Render status: rejected (${renderStatus.failureReason}), observed ${new Date(renderStatus.observedAt).toISOString()}, target ${renderStatus.online ? 'online' : 'offline'}.`
    );
  }
  return `${lines.join('\n')}\n`;
}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) throw new UsageError(`${flag} is required`);
  return value;
}

/** Never accepted positionally or echoed back, so an operator-supplied secret never lands in a log line. */
function resolveSecret(flagValue: string | undefined, env: Readonly<Record<string, string | undefined>>): string {
  const secret = flagValue ?? env.MAILBOX_SECRET;
  if (!secret) throw new UsageError('A mailbox credential is required via --secret or the MAILBOX_SECRET environment variable');
  return secret;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`${flag} must be a positive integer`);
  return parsed;
}
