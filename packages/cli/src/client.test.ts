import assert from 'node:assert/strict';
import test from 'node:test';

import { MailboxApiError, MailboxClient } from './client';

const CHANNEL = { protocolVersion: 1, id: 'main', name: 'Main channel' };

const PROFILE = {
  protocolVersion: 1,
  version: 3,
  contentBox: { width: 1280, height: 720 },
  devicePixelRatio: 1,
  screenshot: { width: 1280, height: 720 },
  preferredIconSize: { min: 16, max: 32 },
  minimumTextSize: 14,
  background: { opaque: true },
  features: [],
};

const RENDER_STATUS = {
  protocolVersion: 1,
  targetId: 'target-1',
  attemptId: 'attempt-1',
  attemptStartedAt: 1000,
  profileVersion: 3,
  currentRevisionId: 'rev-1',
  candidateRevisionId: 'rev-1',
  rendered: { width: 1280, height: 720, scrollWidth: 1280, scrollHeight: 720 },
  overflow: { horizontal: false, vertical: false },
  activation: 'active',
  failureReason: null,
  observedAt: 2000,
  online: true,
};

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorBody(code: string, message: string) {
  return { protocolVersion: 1, code, message };
}

test('inspects a paired channel and reports its target profile and render status', async () => {
  const requests: string[] = [];
  const client = new MailboxClient('https://mailbox.example/', 'pub_secret', async (input) => {
    const url = input.toString();
    requests.push(url);
    if (url.endsWith('/v1/channels/main')) return response(200, CHANNEL);
    if (url.endsWith('/v1/channels/main/profile')) return response(200, PROFILE);
    if (url.endsWith('/v1/channels/main/render-status')) return response(200, RENDER_STATUS);
    throw new Error(`unexpected request: ${url}`);
  });

  const inspection = await client.inspectChannel('main');

  assert.deepEqual(inspection, { state: 'paired', channel: CHANNEL, profile: PROFILE, renderStatus: RENDER_STATUS });
  assert.deepEqual(requests, [
    'https://mailbox.example/v1/channels/main',
    'https://mailbox.example/v1/channels/main/profile',
    'https://mailbox.example/v1/channels/main/render-status',
  ]);
});

test('marks an unbound channel as having no target-accurate preview, and skips the render-status lookup', async () => {
  const requests: string[] = [];
  const client = new MailboxClient('https://mailbox.example/', 'pub_secret', async (input) => {
    const url = input.toString();
    requests.push(url);
    if (url.endsWith('/v1/channels/direct')) return response(200, { protocolVersion: 1, id: 'direct', name: 'Direct' });
    if (url.endsWith('/v1/channels/direct/profile')) return response(404, errorBody('no_profile', "Channel 'direct' has no target profile yet"));
    throw new Error(`unexpected request: ${url}`);
  });

  const inspection = await client.inspectChannel('direct');

  assert.deepEqual(inspection, { state: 'unbound', channel: { protocolVersion: 1, id: 'direct', name: 'Direct' } });
  assert.equal(requests.length, 2);
});

test('treats a paired target that has not reported a render observation yet as pending, not a failure', async () => {
  const client = new MailboxClient('https://mailbox.example/', 'pub_secret', async (input) => {
    const url = input.toString();
    if (url.endsWith('/v1/channels/main')) return response(200, CHANNEL);
    if (url.endsWith('/v1/channels/main/profile')) return response(200, PROFILE);
    if (url.endsWith('/v1/channels/main/render-status')) {
      return response(404, errorBody('no_render_status', "Target 'target-1' has not reported a render observation"));
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const inspection = await client.inspectChannel('main');

  assert.deepEqual(inspection, { state: 'paired', channel: CHANNEL, profile: PROFILE, renderStatus: null });
});

test('surfaces channel-not-found as a structured error rather than throwing a raw HTTP failure', async () => {
  const client = new MailboxClient('https://mailbox.example/', 'pub_secret', async () =>
    response(404, errorBody('channel_not_found', "Channel 'missing' not found"))
  );

  await assert.rejects(
    client.inspectChannel('missing'),
    (error: unknown) => error instanceof MailboxApiError && error.status === 404 && error.code === 'channel_not_found'
  );
});

test('publishes exactly one validated revision using the paired target profile version by default', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new MailboxClient(
    'https://mailbox.example/',
    'pub_secret',
    async (input, init) => {
      const url = input.toString();
      requests.push({ url, init });
      if (url.endsWith('/v1/channels/main/profile')) return response(200, PROFILE);
      if (url.endsWith('/v1/channels/main/revisions/current')) return response(201, JSON.parse(init?.body as string));
      throw new Error(`unexpected request: ${url}`);
    },
    () => 'rev-31'
  );

  const revision = await client.publish({ channel: 'main', title: 'Build guide', html: '<h1>Hello</h1>' });

  assert.deepEqual(revision, {
    protocolVersion: 1,
    id: 'rev-31',
    channel: 'main',
    profileVersion: 3,
    title: 'Build guide',
    description: null,
    html: '<h1>Hello</h1>',
    assetIds: [],
  });
  const publishRequest = requests.find((r) => r.url.endsWith('/revisions/current'));
  assert.ok(publishRequest);
  assert.deepEqual(publishRequest.init?.headers, { authorization: 'Bearer pub_secret', 'content-type': 'application/json' });
});

test('defaults the profile version to 1 when publishing to an unbound channel', async () => {
  const client = new MailboxClient(
    'https://mailbox.example/',
    'pub_secret',
    async (input, init) => {
      const url = input.toString();
      if (url.endsWith('/profile')) return response(404, errorBody('no_profile', 'no profile yet'));
      if (url.endsWith('/revisions/current')) return response(201, JSON.parse(init?.body as string));
      throw new Error(`unexpected request: ${url}`);
    },
    () => 'rev-32'
  );

  const revision = await client.publish({ channel: 'direct', title: 'First cut', html: '<p>Hi</p>' });

  assert.equal(revision.profileVersion, 1);
});

test('an explicit profile version skips the automatic profile lookup', async () => {
  const requests: string[] = [];
  const client = new MailboxClient(
    'https://mailbox.example/',
    'pub_secret',
    async (input, init) => {
      const url = input.toString();
      requests.push(url);
      if (url.endsWith('/revisions/current')) return response(201, JSON.parse(init?.body as string));
      throw new Error(`unexpected request: ${url}`);
    },
    () => 'rev-33'
  );

  const revision = await client.publish({ channel: 'main', title: 'Pinned', html: '<p>Hi</p>', profileVersion: 7 });

  assert.equal(revision.profileVersion, 7);
  assert.deepEqual(requests, ['https://mailbox.example/v1/channels/main/revisions/current']);
});

test('surfaces an authorization failure from a publish attempt as an actionable error', async () => {
  const client = new MailboxClient('https://mailbox.example/', 'bad_secret', async () =>
    response(401, errorBody('unauthorized', 'A valid bearer token is required'))
  );

  await assert.rejects(
    client.publish({ channel: 'main', title: 'x', html: '<p>x</p>', profileVersion: 1 }),
    (error: unknown) => error instanceof MailboxApiError && error.status === 401 && error.code === 'unauthorized'
  );
});

test('surfaces a publish conflict when the channel profile has moved on', async () => {
  const client = new MailboxClient('https://mailbox.example/', 'pub_secret', async () =>
    response(409, errorBody('profile_version_mismatch', 'Revision profile version 1 does not match channel profile version 4'))
  );

  await assert.rejects(
    client.publish({ channel: 'main', title: 'x', html: '<p>x</p>', profileVersion: 1 }),
    (error: unknown) => error instanceof MailboxApiError && error.status === 409 && error.code === 'profile_version_mismatch'
  );
});
