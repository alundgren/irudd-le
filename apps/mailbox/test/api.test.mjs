import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import mailboxPackage from '../build/index.js';

const { createMailboxServer } = mailboxPackage;
const digest = (data) => createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');

test('creates and reads an offline channel through the versioned HTTP API', async (t) => {
  const mailbox = await createMailboxServer({ databasePath: ':memory:', bearerToken: 'test-token' });
  await mailbox.listen();
  t.after(() => mailbox.close());

  const response = await fetch(`${mailbox.url}/v1/channels`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, name: 'main' }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    protocolVersion: 1,
    id: 'main',
    name: 'main',
  });

  const channel = await fetch(`${mailbox.url}/v1/channels/main`, {
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(channel.status, 200);
  assert.deepEqual(await channel.json(), {
    protocolVersion: 1,
    id: 'main',
    name: 'main',
  });
});

test('rejects an unsupported protocol version with a structured API error', async (t) => {
  const mailbox = await createMailboxServer({ databasePath: ':memory:', bearerToken: 'test-token' });
  await mailbox.listen();
  t.after(() => mailbox.close());

  const response = await fetch(`${mailbox.url}/v1/channels`, {
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

test('rejects invalid bearer credentials without exposing channel state', async (t) => {
  const mailbox = await createMailboxServer({ databasePath: ':memory:', bearerToken: 'test-token' });
  await mailbox.listen();
  t.after(() => mailbox.close());

  const response = await fetch(`${mailbox.url}/v1/channels/main`, {
    headers: { authorization: 'Bearer wrong-token' },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    protocolVersion: 1,
    code: 'invalid_credentials',
    message: 'A valid bearer token is required.',
  });
});

test('reopens a database volume with its active revision intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mailbox-api-'));
  const databasePath = join(directory, 'mailbox.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const first = await createMailboxServer({ databasePath, bearerToken: 'test-token' });
  await first.listen();
  await fetch(`${first.url}/v1/channels`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, name: 'main' }),
  });
  const publication = await fetch(`${first.url}/v1/channels/main/revisions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      id: 'rev-001',
      profileVersion: 1,
      html: '<main>Persistent guide</main>',
      assets: [],
    }),
  });
  assert.equal(publication.status, 201);
  await first.close();

  const restarted = await createMailboxServer({ databasePath, bearerToken: 'test-token' });
  await restarted.listen();
  t.after(() => restarted.close());
  const current = await fetch(`${restarted.url}/v1/channels/main/revisions/current`, {
    headers: { authorization: 'Bearer test-token' },
  });

  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), {
    protocolVersion: 1,
    id: 'rev-001',
    channel: 'main',
    profileVersion: 1,
    html: '<main>Persistent guide</main>',
    assetIds: [],
  });
});

test('leaves the active revision intact when an atomic publication fails', async (t) => {
  const mailbox = await createMailboxServer({ databasePath: ':memory:', bearerToken: 'test-token' });
  await mailbox.listen();
  t.after(() => mailbox.close());
  const request = (body) => fetch(`${mailbox.url}/v1/channels/main/revisions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  await fetch(`${mailbox.url}/v1/channels`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, name: 'main' }),
  });
  const asset = { id: 'icon-001', contentType: 'image/png', data: 'AQID', sha256: digest('AQID') };
  assert.equal((await request({ protocolVersion: 1, id: 'rev-001', profileVersion: 1, html: '<main>first</main>', assets: [asset] })).status, 201);

  const rejected = await request({
    protocolVersion: 1, id: 'rev-002', profileVersion: 1, html: '<main>second</main>',
    assets: [{ ...asset, data: 'BAUG', sha256: digest('BAUG') }],
  });
  assert.equal(rejected.status, 409);

  const current = await fetch(`${mailbox.url}/v1/channels/main/revisions/current`, {
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(current.status, 200);
  assert.equal((await current.json()).id, 'rev-001');

  const history = await fetch(`${mailbox.url}/v1/channels/main/revisions/history`, {
    headers: { authorization: 'Bearer test-token' },
  });
  assert.deepEqual((await history.json()).revisions, [{ id: 'rev-001', profileVersion: 1 }]);
});

test('keeps target registration independent from binary revision content', async (t) => {
  const mailbox = await createMailboxServer({ databasePath: ':memory:', bearerToken: 'test-token' });
  await mailbox.listen();
  t.after(() => mailbox.close());
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  await fetch(`${mailbox.url}/v1/channels`, {
    method: 'POST', headers, body: JSON.stringify({ protocolVersion: 1, name: 'offline' }),
  });
  const registration = await fetch(`${mailbox.url}/v1/channels/offline/targets`, {
    method: 'POST', headers, body: JSON.stringify({
      protocolVersion: 1,
      id: 'target-001',
      profile: {
        protocolVersion: 1, version: 1,
        contentBox: { width: 960, height: 540 }, devicePixelRatio: 1,
        screenshot: { width: 960, height: 540 }, preferredIconSize: { min: 24, max: 48 },
        minimumTextSize: 18, background: { opaque: false }, features: [],
      },
    }),
  });
  assert.equal(registration.status, 201);

  const publication = await fetch(`${mailbox.url}/v1/channels/offline/revisions`, {
    method: 'POST', headers, body: JSON.stringify({
      protocolVersion: 1, id: 'rev-001', profileVersion: 1, html: '<img src="asset">',
      assets: [{ id: 'asset-001', contentType: 'application/octet-stream', data: 'AQID', sha256: digest('AQID') }],
    }),
  });
  assert.equal(publication.status, 201);
  const reused = await fetch(`${mailbox.url}/v1/channels/offline/revisions`, {
    method: 'POST', headers, body: JSON.stringify({
      protocolVersion: 1, id: 'rev-002', profileVersion: 1, html: '<img src="asset">',
      assets: [{ id: 'asset-001', contentType: 'application/octet-stream', data: 'AQID', sha256: digest('AQID') }],
    }),
  });
  assert.equal(reused.status, 201);
  const asset = await fetch(`${mailbox.url}/v1/assets/asset-001`, { headers: { authorization: 'Bearer test-token' } });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual([...new Uint8Array(await asset.arrayBuffer())], [1, 2, 3]);
});
