import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMailbox, type MailboxOptions } from './index';

function baseOptions(): MailboxOptions & { databasePath: string } {
  return {
    databasePath: `:memory:`,
    bearerTokens: ['test-token'],
    listen: { host: '127.0.0.1', port: 0 },
  };
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function jsonBody(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function publishableChannel(): object {
  return { protocolVersion: 1, id: 'main', name: 'Main channel' };
}

function publishableRevision(): object {
  return {
    protocolVersion: 1,
    id: 'rev-001',
    channel: 'main',
    profileVersion: 1,
    html: '<h1>hello</h1>',
    assetIds: [],
  };
}

test('rejects missing or invalid bearer credentials on protected endpoints', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const missing = await fetch(new URL('/v1/channels/main', base), { method: 'GET' });
    assert.equal(missing.status, 401);
    assert.equal((await jsonBody(missing)).code, 'unauthorized');

    const wrong = await fetch(new URL('/v1/channels/main', base), {
      method: 'GET',
      headers: authHeader('not-the-token'),
    });
    assert.equal(wrong.status, 401);
    assert.equal((await jsonBody(wrong)).code, 'unauthorized');
  } finally {
    await mailbox.stop();
  }
});

test('creates and reads a channel through the canonical API', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  const headers = { 'content-type': 'application/json', ...authHeader('test-token') };
  try {
    const created = await fetch(new URL('/v1/channels', base), {
      method: 'POST',
      headers,
      body: JSON.stringify(publishableChannel()),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await jsonBody(created), publishableChannel());

    const fetched = await fetch(new URL('/v1/channels/main', base), { method: 'GET', headers: authHeader('test-token') });
    assert.equal(fetched.status, 200);
    assert.deepEqual(await jsonBody(fetched), publishableChannel());

    const missing = await fetch(new URL('/v1/channels/nope', base), { method: 'GET', headers: authHeader('test-token') });
    assert.equal(missing.status, 404);
    assert.equal((await jsonBody(missing)).code, 'channel_not_found');
  } finally {
    await mailbox.stop();
  }
});

test('restarts against the same SQLite file and retains its channels', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mailbox-restart-'));
  const databasePath = path.join(dir, 'mailbox.db');
  const headers = { 'content-type': 'application/json', ...authHeader('test-token') };
  try {
    const first = createMailbox({ ...baseOptions(), databasePath });
    await first.start();
    try {
      const created = await fetch(new URL('/v1/channels', first.url), {
        method: 'POST',
        headers,
        body: JSON.stringify(publishableChannel()),
      });
      assert.equal(created.status, 201);
    } finally {
      await first.stop();
    }

    const second = createMailbox({ ...baseOptions(), databasePath });
    await second.start();
    try {
      const fetched = await fetch(new URL('/v1/channels/main', second.url), {
        method: 'GET',
        headers: authHeader('test-token'),
      });
      assert.equal(fetched.status, 200);
      assert.deepEqual(await jsonBody(fetched), publishableChannel());
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publishes and reads the current revision through the API', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  const headers = { 'content-type': 'application/json', ...authHeader('test-token') };
  try {
    const created = await fetch(new URL('/v1/channels', base), {
      method: 'POST',
      headers,
      body: JSON.stringify(publishableChannel()),
    });
    assert.equal(created.status, 201);

    const published = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers,
      body: JSON.stringify(publishableRevision()),
    });
    assert.equal(published.status, 201);
    assert.deepEqual(await jsonBody(published), publishableRevision());

    const fetched = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'GET',
      headers: authHeader('test-token'),
    });
    assert.equal(fetched.status, 200);
    assert.deepEqual(await jsonBody(fetched), publishableRevision());

    const second = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...publishableRevision(), id: 'rev-002', html: '<h1>updated</h1>' }),
    });
    assert.equal(second.status, 201);

    const current = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'GET',
      headers: authHeader('test-token'),
    });
    assert.equal(current.status, 200);
    assert.deepEqual(await jsonBody(current), {
      ...publishableRevision(),
      id: 'rev-002',
      html: '<h1>updated</h1>',
    });

    await fetch(new URL('/v1/channels', base), {
      method: 'POST',
      headers,
      body: JSON.stringify({ protocolVersion: 1, id: 'empty', name: 'Empty' }),
    });
    const empty = await fetch(new URL('/v1/channels/empty/revisions/current', base), {
      method: 'GET',
      headers: authHeader('test-token'),
    });
    assert.equal(empty.status, 404);
    assert.equal((await jsonBody(empty)).code, 'no_current_revision');
  } finally {
    await mailbox.stop();
  }
});

test('preserves the previous current revision when a publication fails atomically', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  const headers = { 'content-type': 'application/json', ...authHeader('test-token') };
  try {
    await fetch(new URL('/v1/channels', base), {
      method: 'POST',
      headers,
      body: JSON.stringify(publishableChannel()),
    });
    await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers,
      body: JSON.stringify(publishableRevision()),
    });
    const secondBody = { ...publishableRevision(), id: 'rev-002', html: '<h1>second</h1>' };
    await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers,
      body: JSON.stringify(secondBody),
    });

    const conflict = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...publishableRevision(), html: '<h1>forged</h1>' }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await jsonBody(conflict)).code, 'revision_conflict');

    const current = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'GET',
      headers: authHeader('test-token'),
    });
    assert.equal(current.status, 200);
    assert.deepEqual(await jsonBody(current), secondBody);
  } finally {
    await mailbox.stop();
  }
});

test('rejects unsupported protocol versions with a structured protocol error', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  const headers = { 'content-type': 'application/json', ...authHeader('test-token') };
  try {
    const badChannel = await fetch(new URL('/v1/channels', base), {
      method: 'POST',
      headers,
      body: JSON.stringify({ protocolVersion: 2, id: 'bad', name: 'Bad' }),
    });
    assert.equal(badChannel.status, 400);
    const badBody = await jsonBody(badChannel);
    assert.equal(badBody.code, 'unsupported_protocol_version');
    assert.equal(badBody.protocolVersion, 1);

    await fetch(new URL('/v1/channels', base), {
      method: 'POST',
      headers,
      body: JSON.stringify(publishableChannel()),
    });
    const badPublish = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...publishableRevision(), protocolVersion: 2 }),
    });
    assert.equal(badPublish.status, 400);
    const bad = await jsonBody(badPublish);
    assert.equal(bad.code, 'unsupported_protocol_version');
    assert.equal(bad.protocolVersion, 1);
  } finally {
    await mailbox.stop();
  }
});

test('an offline channel retains and accepts content across a restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mailbox-offline-'));
  const databasePath = path.join(dir, 'mailbox.db');
  const headers = { 'content-type': 'application/json', ...authHeader('test-token') };
  try {
    const first = createMailbox({ ...baseOptions(), databasePath });
    await first.start();
    try {
      await fetch(new URL('/v1/channels', first.url), {
        method: 'POST',
        headers,
        body: JSON.stringify({ protocolVersion: 1, id: 'offline', name: 'Offline channel' }),
      });
      const offlineRevision = {
        protocolVersion: 1,
        id: 'rev-offline-1',
        channel: 'offline',
        profileVersion: 1,
        html: '<p>offline content</p>',
        assetIds: [],
      };
      const published = await fetch(new URL('/v1/channels/offline/revisions/current', first.url), {
        method: 'PUT',
        headers,
        body: JSON.stringify(offlineRevision),
      });
      assert.equal(published.status, 201);
    } finally {
      await first.stop();
    }

    const second = createMailbox({ ...baseOptions(), databasePath });
    await second.start();
    try {
      const current = await fetch(new URL('/v1/channels/offline/revisions/current', second.url), {
        method: 'GET',
        headers: authHeader('test-token'),
      });
      assert.equal(current.status, 200);
      assert.deepEqual(await jsonBody(current), {
        protocolVersion: 1,
        id: 'rev-offline-1',
        channel: 'offline',
        profileVersion: 1,
        html: '<p>offline content</p>',
        assetIds: [],
      });
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serves health and readiness from an ephemeral port', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const health = await fetch(new URL('/healthz', base));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, protocolVersion: 1 });

    const ready = await fetch(new URL('/readyz', base));
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true, protocolVersion: 1 });
  } finally {
    await mailbox.stop();
  }
});