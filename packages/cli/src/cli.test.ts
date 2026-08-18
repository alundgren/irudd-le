import assert from 'node:assert/strict';
import test from 'node:test';

import { run, type CliIo } from './cli';
import { MailboxApiError, MailboxClient, type ChannelInspection, type MailboxClientLike, type PublicationInput } from './client';
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
  readBinaryFile?: (path: string) => Promise<Uint8Array>;
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
    uploadAsset: async () => {
      throw new Error('uploadAsset not stubbed');
    },
  };
  const client: MailboxClientLike = { ...fallbackClient, ...overrides.client };
  const io: CliIo = {
    stdout,
    stderr,
    env: overrides.env ?? {},
    readFile: overrides.readFile ?? (async () => 'irrelevant'),
    readBinaryFile: overrides.readBinaryFile ?? (async () => Uint8Array.from([1, 2, 3])),
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
  assert.deepEqual(publishCalls, [{ channel: 'main', title: 'Build guide', description: undefined, html: '<h1>Hi</h1>', profileVersion: undefined, assetIds: undefined }]);
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

test('upload-asset uploads permitted image bytes read from a file and reports the resulting immutable id', async () => {
  const uploadCalls: Array<{ channelId: string; contentType: string; data: Uint8Array }> = [];
  const asset = { protocolVersion: 1 as const, id: 'a'.repeat(64), contentType: 'image/png' as const, byteLength: 3, sha256: 'a'.repeat(64) };
  const { io, stdout } = makeIo({
    client: {
      uploadAsset: async (channelId, contentType, data) => {
        uploadCalls.push({ channelId, contentType, data });
        return asset;
      },
    },
    readBinaryFile: async (path) => {
      assert.equal(path, 'icon.png');
      return Uint8Array.from([1, 2, 3]);
    },
  });

  const code = await run(
    ['upload-asset', '--mailbox-url', 'https://mailbox.example/', '--channel', 'main', '--file', 'icon.png', '--secret', 'pub_x'],
    io
  );

  assert.equal(code, 0);
  assert.deepEqual(uploadCalls, [{ channelId: 'main', contentType: 'image/png', data: Uint8Array.from([1, 2, 3]) }]);
  assert.match(stdout.text, /Uploaded asset 'a{64}' \(image\/png, 3 bytes\) to channel 'main'/);
});

test('upload-asset surfaces an unsupported file extension as a structured protocol error, without uploading', async () => {
  const uploadCalls: unknown[] = [];
  const { io, stderr } = makeIo({
    client: { uploadAsset: async (...args) => { uploadCalls.push(args); throw new Error('should not be called'); } },
  });

  const code = await run(
    ['upload-asset', '--mailbox-url', 'https://mailbox.example/', '--channel', 'main', '--file', 'icon.gif', '--secret', 'pub_x'],
    io
  );

  assert.equal(code, 1);
  assert.match(stderr.text, /contentType must be one of image\/png, image\/webp/);
  assert.deepEqual(uploadCalls, []);
  assert.equal(stderr.text.split('\n').filter((line) => line.length > 0).length, 1);
});

test('publish forwards repeated --asset-id flags to the client as the revision asset ids', async () => {
  const publishCalls: PublicationInput[] = [];
  const revision: Revision = {
    id: 'rev-1',
    channel: 'main',
    profileVersion: 1,
    protocolVersion: 1,
    html: '<img src="asset:aaa">',
    assetIds: ['aaa', 'bbb'],
    title: 'Icon guide',
    description: null,
  };
  const { io, stdout } = makeIo({
    client: {
      publish: async (input) => {
        publishCalls.push(input);
        return revision;
      },
    },
  });

  const code = await run(
    [
      'publish',
      '--mailbox-url', 'https://mailbox.example/',
      '--channel', 'main',
      '--title', 'Icon guide',
      '--html-file', 'guide.html',
      '--asset-id', 'aaa',
      '--asset-id', 'bbb',
      '--secret', 'pub_x',
    ],
    io
  );

  assert.equal(code, 0);
  assert.deepEqual(publishCalls[0]?.assetIds, ['aaa', 'bbb']);
  assert.match(stdout.text, /Published revision 'rev-1'/);
});

test('uploads an image asset then publishes a profiled revision that repeatedly refers to it in HTML, end to end through the CLI and mailbox wire contract', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const asset = { protocolVersion: 1 as const, id: 'a'.repeat(64), contentType: 'image/png' as const, byteLength: 3, sha256: 'a'.repeat(64) };
  const repeatedAssetHtml = `<img src="asset:${asset.id}"><img src="asset:${asset.id}">`;
  const realClient = new MailboxClient('https://mailbox.example/', 'pub_x', async (input, init) => {
    const url = input.toString();
    requests.push({ url, init });
    if (url.endsWith('/assets') && init?.method === 'POST') return new Response(JSON.stringify(asset), { status: 201, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/revisions/current')) return new Response(init?.body as string, { status: 201, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected request: ${url}`);
  });
  const { io, stdout } = makeIo({
    client: { uploadAsset: (channelId, contentType, data) => realClient.uploadAsset(channelId, contentType, data), publish: (input) => realClient.publish(input) },
    readBinaryFile: async () => Uint8Array.from([1, 2, 3]),
    readFile: async () => repeatedAssetHtml,
  });

  const uploadCode = await run(
    ['upload-asset', '--mailbox-url', 'https://mailbox.example/', '--channel', 'main', '--file', 'icon.png', '--secret', 'pub_x'],
    io
  );
  const publishCode = await run(
    [
      'publish',
      '--mailbox-url', 'https://mailbox.example/',
      '--channel', 'main',
      '--title', 'Icon guide',
      '--html-file', 'guide.html',
      '--profile-version', '1',
      '--asset-id', asset.id,
      '--secret', 'pub_x',
    ],
    io
  );

  assert.equal(uploadCode, 0);
  assert.equal(publishCode, 0);
  assert.match(stdout.text, /Uploaded asset 'a{64}'/);
  assert.match(stdout.text, /Published revision/);
  const publishRequest = requests.find((r) => r.url.endsWith('/revisions/current'));
  const publishedRevision = JSON.parse(publishRequest?.init?.body as string);
  assert.deepEqual(publishedRevision.assetIds, [asset.id]);
  assert.equal(publishedRevision.html, repeatedAssetHtml);
});

test('publish reports a duplicate --asset-id as one structured, actionable error line', async () => {
  const realClient = new MailboxClient('https://mailbox.example/', 'pub_x', async () => {
    throw new Error('a duplicate asset id must be rejected before any network request');
  });
  const { io, stderr } = makeIo({ client: { publish: (input) => realClient.publish(input) } });

  const code = await run(
    [
      'publish',
      '--mailbox-url', 'https://mailbox.example/',
      '--channel', 'main',
      '--title', 'x',
      '--html-file', 'guide.html',
      '--profile-version', '1',
      '--asset-id', 'aaa',
      '--asset-id', 'aaa',
      '--secret', 'pub_x',
    ],
    io
  );

  assert.equal(code, 1);
  assert.match(stderr.text, /duplicate id 'aaa'/);
  assert.equal(stderr.text.split('\n').filter((line) => line.length > 0).length, 1);
});
