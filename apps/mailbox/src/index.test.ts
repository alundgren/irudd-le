import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMailbox } from './index';

test('reports health without credentials', async (t) => {
  const mailbox = createMailbox({ databasePath: ':memory:', bearerToken: 'test-token' });
  const address = await mailbox.listen();
  t.after(() => mailbox.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('creates and reads a channel through the versioned API', async (t) => {
  const mailbox = createMailbox({ databasePath: ':memory:', bearerToken: 'test-token' });
  const address = await mailbox.listen();
  t.after(() => mailbox.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${baseUrl}/v1/channels`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, name: 'main' }),
  });

  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    protocolVersion: 1,
    id: 'main',
    name: 'main',
    currentRevisionId: null,
  });

  const read = await fetch(`${baseUrl}/v1/channels/main`, {
    headers: { authorization: 'Bearer test-token' },
  });

  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), {
    protocolVersion: 1,
    id: 'main',
    name: 'main',
    currentRevisionId: null,
  });
});

test('rejects invalid credentials with a structured error', async (t) => {
  const mailbox = createMailbox({ databasePath: ':memory:', bearerToken: 'test-token' });
  const address = await mailbox.listen();
  t.after(() => mailbox.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/channels/main`, {
    headers: { authorization: 'Bearer wrong-token' },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    protocolVersion: 1,
    code: 'invalid_credentials',
    message: 'A valid bearer token is required.',
  });
});

test('rejects unsupported protocol versions explicitly', async (t) => {
  const mailbox = createMailbox({ databasePath: ':memory:', bearerToken: 'test-token' });
  const address = await mailbox.listen();
  t.after(() => mailbox.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/channels`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 2, name: 'main' }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    protocolVersion: 1,
    code: 'unsupported_protocol_version',
    message: 'protocolVersion must be 1',
  });
});

test('an offline channel accepts and exposes a revision', async (t) => {
  const mailbox = createMailbox({ databasePath: ':memory:', bearerToken: 'test-token' });
  const address = await mailbox.listen();
  t.after(() => mailbox.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  await fetch(`${baseUrl}/v1/channels`, {
    method: 'POST', headers, body: JSON.stringify({ protocolVersion: 1, name: 'main' }),
  });

  const published = await fetch(`${baseUrl}/v1/channels/main/revisions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ protocolVersion: 1, profileVersion: 1, html: '<main>boss timer</main>', assetIds: [] }),
  });

  assert.equal(published.status, 201);
  assert.deepEqual(await published.json(), {
    protocolVersion: 1,
    id: 'main:1',
    channel: 'main',
    profileVersion: 1,
    html: '<main>boss timer</main>',
    assetIds: [],
  });

  const channel = await fetch(`${baseUrl}/v1/channels/main`, { headers });
  assert.deepEqual(await channel.json(), {
    protocolVersion: 1,
    id: 'main',
    name: 'main',
    currentRevisionId: 'main:1',
  });
});

test('stores and reads binary assets as SQLite BLOBs', async (t) => {
  const mailbox = createMailbox({ databasePath: ':memory:', bearerToken: 'test-token' });
  const address = await mailbox.listen();
  t.after(() => mailbox.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  const sha256 = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';

  const uploaded = await fetch(`${baseUrl}/v1/assets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ protocolVersion: 1, contentType: 'text/plain', contentBase64: 'aGVsbG8gd29ybGQ=' }),
  });

  assert.equal(uploaded.status, 201);
  assert.deepEqual(await uploaded.json(), {
    protocolVersion: 1,
    id: sha256,
    contentType: 'text/plain',
    byteLength: 11,
    sha256,
  });

  const downloaded = await fetch(`${baseUrl}/v1/assets/${sha256}`, { headers });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'text/plain');
  assert.equal(await downloaded.text(), 'hello world');
});

test('leaves the active revision unchanged when publication cannot resolve an asset', async (t) => {
  const mailbox = createMailbox({ databasePath: ':memory:', bearerToken: 'test-token' });
  const address = await mailbox.listen();
  t.after(() => mailbox.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  await fetch(`${baseUrl}/v1/channels`, {
    method: 'POST', headers, body: JSON.stringify({ protocolVersion: 1, name: 'main' }),
  });
  await fetch(`${baseUrl}/v1/channels/main/revisions`, {
    method: 'POST', headers,
    body: JSON.stringify({ protocolVersion: 1, profileVersion: 1, html: '<main>stable</main>', assetIds: [] }),
  });

  const rejected = await fetch(`${baseUrl}/v1/channels/main/revisions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ protocolVersion: 1, profileVersion: 1, html: '<main>broken</main>', assetIds: ['missing'] }),
  });

  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), {
    protocolVersion: 1,
    code: 'asset_not_found',
    message: 'Asset missing does not exist.',
  });
  const channel = await fetch(`${baseUrl}/v1/channels/main`, { headers });
  assert.equal((await channel.json() as { currentRevisionId: string }).currentRevisionId, 'main:1');
});

test('rolls back a duplicate asset ID failure after starting publication', async (t) => {
  const mailbox = createMailbox({ databasePath: ':memory:', bearerToken: 'test-token' });
  const address = await mailbox.listen();
  t.after(() => mailbox.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  const assetId = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
  await fetch(`${baseUrl}/v1/channels`, {
    method: 'POST', headers, body: JSON.stringify({ protocolVersion: 1, name: 'main' }),
  });
  await fetch(`${baseUrl}/v1/assets`, {
    method: 'POST', headers,
    body: JSON.stringify({ protocolVersion: 1, contentType: 'text/plain', contentBase64: 'aGVsbG8gd29ybGQ=' }),
  });

  const rejected = await fetch(`${baseUrl}/v1/channels/main/revisions`, {
    method: 'POST', headers,
    body: JSON.stringify({ protocolVersion: 1, profileVersion: 1, html: '<main>duplicate</main>', assetIds: [assetId, assetId] }),
  });

  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), {
    protocolVersion: 1,
    code: 'duplicate_asset_id',
    message: `assetIds must not repeat ${assetId}`,
  });
  const channel = await fetch(`${baseUrl}/v1/channels/main`, { headers });
  assert.equal((await channel.json() as { currentRevisionId: string | null }).currentRevisionId, null);
  const revision = await fetch(`${baseUrl}/v1/revisions/main%3A1`, { headers });
  assert.equal(revision.status, 404);
});

test('reopens a database volume without losing channel revisions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'irudd-mailbox-'));
  const databasePath = join(directory, 'mailbox.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  const first = createMailbox({ databasePath, bearerToken: 'test-token' });
  const firstAddress = await first.listen();
  const firstUrl = `http://127.0.0.1:${firstAddress.port}`;
  await fetch(`${firstUrl}/v1/channels`, {
    method: 'POST', headers, body: JSON.stringify({ protocolVersion: 1, name: 'main' }),
  });
  await fetch(`${firstUrl}/v1/channels/main/revisions`, {
    method: 'POST', headers,
    body: JSON.stringify({ protocolVersion: 1, profileVersion: 1, html: '<main>persisted</main>', assetIds: [] }),
  });
  await fetch(`${firstUrl}/v1/channels/main/revisions`, {
    method: 'POST', headers,
    body: JSON.stringify({ protocolVersion: 1, profileVersion: 2, html: '<main>current</main>', assetIds: [] }),
  });
  await first.close();

  const reopened = createMailbox({ databasePath, bearerToken: 'test-token' });
  const reopenedAddress = await reopened.listen();
  t.after(() => reopened.close());
  const channel = await fetch(`http://127.0.0.1:${reopenedAddress.port}/v1/channels/main`, { headers });

  assert.equal(channel.status, 200);
  assert.equal((await channel.json() as { currentRevisionId: string }).currentRevisionId, 'main:2');
  const persisted = await fetch(`http://127.0.0.1:${reopenedAddress.port}/v1/revisions/main%3A1`, { headers });
  assert.deepEqual(await persisted.json(), {
    protocolVersion: 1,
    id: 'main:1',
    channel: 'main',
    profileVersion: 1,
    html: '<main>persisted</main>',
    assetIds: [],
  });
  const history = await fetch(`http://127.0.0.1:${reopenedAddress.port}/v1/channels/main/revisions`, { headers });
  assert.deepEqual(await history.json(), {
    protocolVersion: 1,
    revisions: [
      { id: 'main:1', profileVersion: 1, assetIds: [] },
      { id: 'main:2', profileVersion: 2, assetIds: [] },
    ],
  });
});

test('registers a target independently of its connectivity', async (t) => {
  const mailbox = createMailbox({ databasePath: ':memory:', bearerToken: 'test-token' });
  const address = await mailbox.listen();
  t.after(() => mailbox.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  await fetch(`${baseUrl}/v1/channels`, {
    method: 'POST', headers, body: JSON.stringify({ protocolVersion: 1, name: 'main' }),
  });
  const profile = {
    protocolVersion: 1,
    version: 1,
    contentBox: { width: 960, height: 540 },
    devicePixelRatio: 1,
    screenshot: { width: 960, height: 540 },
    preferredIconSize: { min: 16, max: 32 },
    minimumTextSize: 12,
    background: { opaque: false },
    features: [],
  };

  const registered = await fetch(`${baseUrl}/v1/channels/main/target`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ protocolVersion: 1, id: 'living-room', profile }),
  });

  assert.equal(registered.status, 201);
  assert.deepEqual(await registered.json(), { protocolVersion: 1, id: 'living-room', channel: 'main', profile });
});

test('rejects a target registration that would move it to another channel', async (t) => {
  const mailbox = createMailbox({ databasePath: ':memory:', bearerToken: 'test-token' });
  const address = await mailbox.listen();
  t.after(() => mailbox.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  const profile = {
    protocolVersion: 1, version: 1, contentBox: { width: 960, height: 540 }, devicePixelRatio: 1,
    screenshot: { width: 960, height: 540 }, preferredIconSize: { min: 16, max: 32 }, minimumTextSize: 12,
    background: { opaque: false }, features: [],
  };
  for (const name of ['first', 'second']) {
    await fetch(`${baseUrl}/v1/channels`, {
      method: 'POST', headers, body: JSON.stringify({ protocolVersion: 1, name }),
    });
  }
  await fetch(`${baseUrl}/v1/channels/first/target`, {
    method: 'PUT', headers, body: JSON.stringify({ protocolVersion: 1, id: 'living-room', profile }),
  });

  const rejected = await fetch(`${baseUrl}/v1/channels/second/target`, {
    method: 'PUT', headers, body: JSON.stringify({ protocolVersion: 1, id: 'living-room', profile }),
  });

  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), {
    protocolVersion: 1,
    code: 'target_already_registered',
    message: 'Target living-room is already registered to channel first.',
  });
});
