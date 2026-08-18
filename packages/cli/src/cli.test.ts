import assert from 'node:assert/strict';
import test from 'node:test';

import { run, type CliIo } from './cli';
import { MailboxApiError, type ChannelInspection, type MailboxClientLike, type PublicationInput } from './client';
import type { Revision } from '@irudd-le/protocol';

const CHANNEL = { protocolVersion: 1 as const, id: 'main', name: 'Main channel' };

function collectingWriter(): { write(chunk: string): void; text: string } {
  let text = '';
  return {
    write(chunk: string) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

function makeIo(overrides: {
  client?: Partial<MailboxClientLike>;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => Promise<string>;
  createClientCalls?: Array<{ mailboxUrl: string; secret: string }>;
}): { io: CliIo; stdout: { text: string }; stderr: { text: string } } {
  const stdout = collectingWriter();
  const stderr = collectingWriter();
  const fallbackClient: MailboxClientLike = {
    inspectChannel: async () => {
      throw new Error('inspectChannel not stubbed');
    },
    publish: async () => {
      throw new Error('publish not stubbed');
    },
  };
  const client: MailboxClientLike = { ...fallbackClient, ...overrides.client };
  const io: CliIo = {
    stdout,
    stderr,
    env: overrides.env ?? {},
    readFile: overrides.readFile ?? (async () => 'irrelevant'),
    createClient: (mailboxUrl, secret) => {
      overrides.createClientCalls?.push({ mailboxUrl, secret });
      return client;
    },
  };
  return { io, stdout, stderr };
}

test('status reports an unbound channel with no target-accurate preview', async () => {
  const inspection: ChannelInspection = { state: 'unbound', channel: CHANNEL };
  const { io, stdout } = makeIo({ client: { inspectChannel: async () => inspection } });

  const code = await run(['status', '--mailbox-url', 'https://mailbox.example/', '--channel', 'main', '--secret', 'pub_x'], io);

  assert.equal(code, 0);
  assert.match(stdout.text, /unbound.*no target-accurate preview/);
});

test('status reports a paired target profile and render status', async () => {
  const inspection: ChannelInspection = {
    state: 'paired',
    channel: CHANNEL,
    profile: {
      protocolVersion: 1,
      version: 2,
      contentBox: { width: 800, height: 600 },
      devicePixelRatio: 1,
      screenshot: { width: 800, height: 600 },
      preferredIconSize: { min: 16, max: 32 },
      minimumTextSize: 12,
      background: { opaque: true },
      features: [],
    },
    renderStatus: null,
  };
  const { io, stdout } = makeIo({ client: { inspectChannel: async () => inspection } });

  const code = await run(['status', '--mailbox-url', 'https://mailbox.example/', '--channel', 'main', '--secret', 'pub_x'], io);

  assert.equal(code, 0);
  assert.match(stdout.text, /paired, profile v2/);
  assert.match(stdout.text, /has not reported an observation yet/);
});

test('status reads the credential from MAILBOX_SECRET when --secret is absent', async () => {
  const createClientCalls: Array<{ mailboxUrl: string; secret: string }> = [];
  const inspection: ChannelInspection = { state: 'unbound', channel: CHANNEL };
  const { io } = makeIo({
    client: { inspectChannel: async () => inspection },
    env: { MAILBOX_SECRET: 'env_secret' },
    createClientCalls,
  });

  const code = await run(['status', '--mailbox-url', 'https://mailbox.example/', '--channel', 'main'], io);

  assert.equal(code, 0);
  assert.deepEqual(createClientCalls, [{ mailboxUrl: 'https://mailbox.example/', secret: 'env_secret' }]);
});

test('refuses to run without a credential, and never attempts a request', async () => {
  const createClientCalls: Array<{ mailboxUrl: string; secret: string }> = [];
  const { io, stderr } = makeIo({ env: {}, createClientCalls });

  const code = await run(['status', '--mailbox-url', 'https://mailbox.example/', '--channel', 'main'], io);

  assert.equal(code, 1);
  assert.match(stderr.text, /credential is required/);
  assert.deepEqual(createClientCalls, []);
});

test('reports an unrecognized flag as one actionable stderr line, not a raw parseArgs stack trace', async () => {
  const { io, stderr } = makeIo({ env: {} });

  const code = await run(['status', '--mailbox-url', 'https://mailbox.example/', '--chanel', 'main', '--secret', 'pub_x'], io);

  assert.equal(code, 1);
  assert.equal(stderr.text.split('\n').filter((line) => line.length > 0).length, 1);
  assert.doesNotMatch(stderr.text, /at Object|node:internal/);
});

test('reports an unreadable HTML file as one actionable stderr line, not a raw fs stack trace', async () => {
  const { io, stderr } = makeIo({
    env: {},
    readFile: async (path) => {
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    },
  });

  const code = await run(
    ['publish', '--mailbox-url', 'https://mailbox.example/', '--channel', 'main', '--title', 'x', '--html-file', 'missing.html', '--secret', 'pub_x'],
    io
  );

  assert.equal(code, 1);
  assert.match(stderr.text, /ENOENT/);
  assert.equal(stderr.text.split('\n').filter((line) => line.length > 0).length, 1);
});

test('publish reads self-contained HTML from a file and reports the published revision', async () => {
  const publishCalls: PublicationInput[] = [];
  const revision: Revision = {
    id: 'rev-1',
    channel: 'main',
    profileVersion: 1,
    protocolVersion: 1,
    html: '<h1>Hi</h1>',
    assetIds: [],
    title: 'Build guide',
    description: null,
  };
  const { io, stdout } = makeIo({
    client: {
      publish: async (input) => {
        publishCalls.push(input);
        return revision;
      },
    },
    readFile: async (path) => {
      assert.equal(path, 'guide.html');
      return '<h1>Hi</h1>';
    },
  });

  const code = await run(
    [
      'publish',
      '--mailbox-url', 'https://mailbox.example/',
      '--channel', 'main',
      '--title', 'Build guide',
      '--html-file', 'guide.html',
      '--secret', 'pub_x',
    ],
    io
  );

  assert.equal(code, 0);
  assert.deepEqual(publishCalls, [{ channel: 'main', title: 'Build guide', description: undefined, html: '<h1>Hi</h1>', profileVersion: undefined }]);
  assert.match(stdout.text, /Published revision 'rev-1' to channel 'main'/);
});

test('publish reports a structured protocol error and exits non-zero without leaking the credential', async () => {
  const { io, stdout, stderr } = makeIo({
    client: {
      publish: async () => {
        throw new MailboxApiError(409, 'current_revision_conflict', "Channel 'main' no longer has the expected current revision");
      },
    },
  });

  const code = await run(
    [
      'publish',
      '--mailbox-url', 'https://mailbox.example/',
      '--channel', 'main',
      '--title', 'x',
      '--html-file', 'guide.html',
      '--secret', 'super-secret-value',
    ],
    io
  );

  assert.equal(code, 1);
  assert.match(stderr.text, /current_revision_conflict/);
  assert.ok(!stdout.text.includes('super-secret-value'));
  assert.ok(!stderr.text.includes('super-secret-value'));
});
