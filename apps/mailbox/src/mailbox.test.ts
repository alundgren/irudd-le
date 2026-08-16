import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createMailbox, type MailboxOptions } from './index';
import { TARGET_ONLINE_WINDOW_MS } from './mailbox';

const ADMIN_SECRET = 'test-admin';

function baseOptions(): MailboxOptions & { databasePath: string } {
  return {
    databasePath: `:memory:`,
    adminBootstrapToken: ADMIN_SECRET,
    listen: { host: '127.0.0.1', port: 0 },
  };
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function jsonHeaders(token: string): Record<string, string> {
  return { 'content-type': 'application/json', ...authHeader(token) };
}

async function jsonBody(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function publishableChannel(id = 'main', name = 'Main channel'): object {
  return { protocolVersion: 1, id, name };
}

function registerableProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    contentBox: { width: 960, height: 540 },
    devicePixelRatio: 2,
    screenshot: { width: 1920, height: 1080 },
    preferredIconSize: { min: 16, max: 48 },
    minimumTextSize: 12,
    background: { opaque: false },
    features: [],
    protocolVersion: 1,
    ...overrides,
  };
}

function heartbeatPayload(profile: object): object {
  return { profile, capabilities: ['render-status'], clientVersion: '0.1.1' };
}

async function registerTarget(
  base: string,
  clientName = 'Living room PC',
  profile: object = registerableProfile()
): Promise<{ id: string; secret: string; pairingCode: string; pairingCodeExpiresAt: number }> {
  const res = await fetch(new URL('/v1/targets', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientName, profile }),
  });
  assert.equal(res.status, 201);
  return (await jsonBody(res)) as { id: string; secret: string; pairingCode: string; pairingCodeExpiresAt: number };
}

async function pairTarget(
  base: string,
  adminToken: string,
  targetId: string,
  pairingCode: string,
  channelId: string,
  channelName: string
): Promise<Response> {
  return fetch(new URL(`/v1/admin/targets/${targetId}/pair`, base), {
    method: 'POST',
    headers: jsonHeaders(adminToken),
    body: JSON.stringify({ protocolVersion: 1, pairingCode, channelId, channelName }),
  });
}

function publishableRevision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    id: 'rev-001',
    channel: 'main',
    profileVersion: 1,
    html: '<h1>hello</h1>',
    assetIds: [],
    title: 'Guide',
    description: null,
    ...overrides,
  };
}

async function createChannel(base: string, adminToken: string, channel: object = publishableChannel()): Promise<void> {
  const res = await fetch(new URL('/v1/channels', base), {
    method: 'POST',
    headers: jsonHeaders(adminToken),
    body: JSON.stringify(channel),
  });
  assert.equal(res.status, 201);
}

async function mintToken(
  base: string,
  adminToken: string,
  kind: 'publisher' | 'reader' | 'admin',
  channel: string | null,
  label: string
): Promise<{ id: string; secret: string }> {
  const res = await fetch(new URL('/v1/admin/tokens', base), {
    method: 'POST',
    headers: jsonHeaders(adminToken),
    body: JSON.stringify({ protocolVersion: 1, kind, channel: channel ?? undefined, label }),
  });
  assert.equal(res.status, 201);
  const body = await jsonBody(res);
  return { id: body.id as string, secret: body.secret as string };
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
      headers: authHeader('not-a-real-token'),
    });
    assert.equal(wrong.status, 401);
    assert.equal((await jsonBody(wrong)).code, 'unauthorized');
  } finally {
    await mailbox.stop();
  }
});

test('refuses to start on a fresh database with no admin token and no bootstrap secret', async () => {
  const mailbox = createMailbox({ ...baseOptions(), adminBootstrapToken: undefined });
  await assert.rejects(() => mailbox.start());
});

test('creates and reads a channel through the canonical API as admin', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);

    const fetched = await fetch(new URL('/v1/channels/main', base), { method: 'GET', headers: authHeader(ADMIN_SECRET) });
    assert.equal(fetched.status, 200);
    assert.deepEqual(await jsonBody(fetched), publishableChannel());

    const missing = await fetch(new URL('/v1/channels/nope', base), { method: 'GET', headers: authHeader(ADMIN_SECRET) });
    assert.equal(missing.status, 404);
    assert.equal((await jsonBody(missing)).code, 'channel_not_found');
  } finally {
    await mailbox.stop();
  }
});

test('rejects a channel id that is not a slug', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const rejected = await fetch(new URL('/v1/channels', base), {
      method: 'POST',
      headers: jsonHeaders(ADMIN_SECRET),
      body: JSON.stringify({ protocolVersion: 1, id: '../../etc/passwd', name: 'Traversal' }),
    });
    assert.equal(rejected.status, 400);
    const body = await jsonBody(rejected);
    assert.equal(body.code, 'invalid_protocol_value');
    assert.equal(body.protocolVersion, 1);
  } finally {
    await mailbox.stop();
  }
});

test('restarts against the same SQLite file and retains channels and tokens without re-bootstrapping', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mailbox-restart-'));
  const databasePath = path.join(dir, 'mailbox.db');
  try {
    const first = createMailbox({ ...baseOptions(), databasePath });
    await first.start();
    let publisherSecret: string;
    try {
      await createChannel(first.url, ADMIN_SECRET);
      publisherSecret = (await mintToken(first.url, ADMIN_SECRET, 'publisher', 'main', 'Guide bot')).secret;
    } finally {
      await first.stop();
    }

    // No adminBootstrapToken this time: the admin token already exists in the file, so bootstrap must not run again.
    const second = createMailbox({ ...baseOptions(), databasePath, adminBootstrapToken: undefined });
    await second.start();
    try {
      const fetched = await fetch(new URL('/v1/channels/main', second.url), { method: 'GET', headers: authHeader(ADMIN_SECRET) });
      assert.equal(fetched.status, 200);

      const published = await fetch(new URL('/v1/channels/main/revisions/current', second.url), {
        method: 'PUT',
        headers: jsonHeaders(publisherSecret),
        body: JSON.stringify(publishableRevision()),
      });
      assert.equal(published.status, 201);
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mints scoped publisher and reader tokens, publishes and reads revisions through the API', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');
    const reader = await mintToken(base, ADMIN_SECRET, 'reader', 'main', 'Overlay main');

    const published = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision()),
    });
    assert.equal(published.status, 201);
    assert.deepEqual(await jsonBody(published), publishableRevision());

    const readByReader = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'GET',
      headers: authHeader(reader.secret),
    });
    assert.equal(readByReader.status, 200);
    assert.deepEqual(await jsonBody(readByReader), publishableRevision());

    const readByPublisher = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'GET',
      headers: authHeader(publisher.secret),
    });
    assert.equal(readByPublisher.status, 200);

    const second = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision({ id: 'rev-002', html: '<h1>updated</h1>' })),
    });
    assert.equal(second.status, 201);

    const current = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'GET',
      headers: authHeader(reader.secret),
    });
    assert.deepEqual(await jsonBody(current), publishableRevision({ id: 'rev-002', html: '<h1>updated</h1>' }));

    await createChannel(base, ADMIN_SECRET, publishableChannel('empty', 'Empty'));
    const emptyReader = await mintToken(base, ADMIN_SECRET, 'reader', 'empty', 'Overlay empty');
    const empty = await fetch(new URL('/v1/channels/empty/revisions/current', base), {
      method: 'GET',
      headers: authHeader(emptyReader.secret),
    });
    assert.equal(empty.status, 404);
    assert.equal((await jsonBody(empty)).code, 'no_current_revision');
  } finally {
    await mailbox.stop();
  }
});

test('a publisher cannot read or write an unauthorized channel', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET, publishableChannel('main', 'Main'));
    await createChannel(base, ADMIN_SECRET, publishableChannel('other', 'Other'));
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');

    const wrongPublish = await fetch(new URL('/v1/channels/other/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision({ channel: 'other' })),
    });
    assert.equal(wrongPublish.status, 403);
    assert.equal((await jsonBody(wrongPublish)).code, 'forbidden');

    const wrongRead = await fetch(new URL('/v1/channels/other', base), { method: 'GET', headers: authHeader(publisher.secret) });
    assert.equal(wrongRead.status, 403);

    const wrongRevisionRead = await fetch(new URL('/v1/channels/other/revisions/current', base), {
      method: 'GET',
      headers: authHeader(publisher.secret),
    });
    assert.equal(wrongRevisionRead.status, 403);

    const ownPublish = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision()),
    });
    assert.equal(ownPublish.status, 201);
  } finally {
    await mailbox.stop();
  }
});

test('an overlay (reader) credential cannot publish or administer', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);
    const reader = await mintToken(base, ADMIN_SECRET, 'reader', 'main', 'Overlay main');

    const publishAttempt = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(reader.secret),
      body: JSON.stringify(publishableRevision()),
    });
    assert.equal(publishAttempt.status, 403);

    const createChannelAttempt = await fetch(new URL('/v1/channels', base), {
      method: 'POST',
      headers: jsonHeaders(reader.secret),
      body: JSON.stringify(publishableChannel('other', 'Other')),
    });
    assert.equal(createChannelAttempt.status, 403);

    const createTokenAttempt = await fetch(new URL('/v1/admin/tokens', base), {
      method: 'POST',
      headers: jsonHeaders(reader.secret),
      body: JSON.stringify({ protocolVersion: 1, kind: 'reader', channel: 'main', label: 'x' }),
    });
    assert.equal(createTokenAttempt.status, 403);

    const listTokensAttempt = await fetch(new URL('/v1/admin/tokens', base), { method: 'GET', headers: authHeader(reader.secret) });
    assert.equal(listTokensAttempt.status, 403);

    const revokeAttempt = await fetch(new URL(`/v1/admin/tokens/${reader.id}`, base), {
      method: 'DELETE',
      headers: authHeader(reader.secret),
    });
    assert.equal(revokeAttempt.status, 403);
  } finally {
    await mailbox.stop();
  }
});

test('refuses to revoke the last active admin token but allows it once another admin exists', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const listed = await fetch(new URL('/v1/admin/tokens', base), { method: 'GET', headers: authHeader(ADMIN_SECRET) });
    const bootstrapId = (await jsonBody(listed)).tokens[0].id as string;

    const lockoutAttempt = await fetch(new URL(`/v1/admin/tokens/${bootstrapId}`, base), {
      method: 'DELETE',
      headers: authHeader(ADMIN_SECRET),
    });
    assert.equal(lockoutAttempt.status, 409);
    assert.equal((await jsonBody(lockoutAttempt)).code, 'last_admin_token');

    const secondAdmin = await mintToken(base, ADMIN_SECRET, 'admin', null, 'Second admin');

    const nowAllowed = await fetch(new URL(`/v1/admin/tokens/${bootstrapId}`, base), {
      method: 'DELETE',
      headers: authHeader(ADMIN_SECRET),
    });
    assert.equal(nowAllowed.status, 204);

    // The freshly minted admin token can administer on its own, and is itself now the last active admin.
    const lastOneLeft = await fetch(new URL(`/v1/admin/tokens/${secondAdmin.id}`, base), {
      method: 'DELETE',
      headers: authHeader(secondAdmin.secret),
    });
    assert.equal(lastOneLeft.status, 409);
  } finally {
    await mailbox.stop();
  }
});

test('revocation takes effect without restarting the mailbox', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');

    const beforeRevoke = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision()),
    });
    assert.equal(beforeRevoke.status, 201);

    const revoked = await fetch(new URL(`/v1/admin/tokens/${publisher.id}`, base), {
      method: 'DELETE',
      headers: authHeader(ADMIN_SECRET),
    });
    assert.equal(revoked.status, 204);

    const afterRevoke = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision({ id: 'rev-002' })),
    });
    assert.equal(afterRevoke.status, 401);
    assert.equal((await jsonBody(afterRevoke)).code, 'unauthorized');

    const missingToken = await fetch(new URL('/v1/admin/tokens/does-not-exist', base), {
      method: 'DELETE',
      headers: authHeader(ADMIN_SECRET),
    });
    assert.equal(missingToken.status, 404);

    // revoking again is idempotent
    const revokedAgain = await fetch(new URL(`/v1/admin/tokens/${publisher.id}`, base), {
      method: 'DELETE',
      headers: authHeader(ADMIN_SECRET),
    });
    assert.equal(revokedAgain.status, 204);
  } finally {
    await mailbox.stop();
  }
});

test('hashes secrets at rest and only returns the full value on creation', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);
    const created = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');

    const listed = await fetch(new URL('/v1/admin/tokens', base), { method: 'GET', headers: authHeader(ADMIN_SECRET) });
    assert.equal(listed.status, 200);
    const body = await jsonBody(listed);
    const summaries = body.tokens as Array<Record<string, unknown>>;
    const match = summaries.find((t) => t.id === created.id);
    assert.ok(match, 'created token should be listed');
    assert.equal(match!.label, 'Guide bot');
    assert.equal(match!.kind, 'publisher');
    assert.equal(match!.channel, 'main');
    assert.equal(match!.revokedAt, null);
    assert.equal('secret' in match!, false);
    assert.equal('secretHash' in match!, false);
    for (const summary of summaries) {
      assert.equal('secret' in summary, false);
    }
  } finally {
    await mailbox.stop();
  }
});

test('requires a channel for publisher and reader tokens and forbids one for admin tokens', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);

    const missingChannel = await fetch(new URL('/v1/admin/tokens', base), {
      method: 'POST',
      headers: jsonHeaders(ADMIN_SECRET),
      body: JSON.stringify({ protocolVersion: 1, kind: 'reader', label: 'Overlay' }),
    });
    assert.equal(missingChannel.status, 400);

    const unexpectedChannel = await fetch(new URL('/v1/admin/tokens', base), {
      method: 'POST',
      headers: jsonHeaders(ADMIN_SECRET),
      body: JSON.stringify({ protocolVersion: 1, kind: 'admin', channel: 'main', label: 'Ops' }),
    });
    assert.equal(unexpectedChannel.status, 400);

    const unknownChannel = await fetch(new URL('/v1/admin/tokens', base), {
      method: 'POST',
      headers: jsonHeaders(ADMIN_SECRET),
      body: JSON.stringify({ protocolVersion: 1, kind: 'publisher', channel: 'nope', label: 'Guide bot' }),
    });
    assert.equal(unknownChannel.status, 404);
  } finally {
    await mailbox.stop();
  }
});

test('preserves the previous current revision when a publication fails atomically', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');
    const reader = await mintToken(base, ADMIN_SECRET, 'reader', 'main', 'Overlay main');

    await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision()),
    });
    const secondBody = publishableRevision({ id: 'rev-002', html: '<h1>second</h1>' });
    await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(secondBody),
    });

    const conflict = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision({ html: '<h1>forged</h1>' })),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await jsonBody(conflict)).code, 'revision_conflict');

    const current = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'GET',
      headers: authHeader(reader.secret),
    });
    assert.equal(current.status, 200);
    assert.deepEqual(await jsonBody(current), secondBody);
  } finally {
    await mailbox.stop();
  }
});

test('conditionally publishes only when the expected current revision still matches', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');
    const reader = await mintToken(base, ADMIN_SECRET, 'reader', 'main', 'Overlay main');

    const first = publishableRevision({ expectedCurrentRevisionId: null });
    const firstResponse = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(first),
    });
    assert.equal(firstResponse.status, 201);

    const second = publishableRevision({
      id: 'rev-002',
      html: '<h1>second</h1>',
      expectedCurrentRevisionId: 'rev-001',
    });
    const secondResponse = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(second),
    });
    assert.equal(secondResponse.status, 201);

    const stale = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(
        publishableRevision({ id: 'rev-003', html: '<h1>stale</h1>', expectedCurrentRevisionId: 'rev-001' })
      ),
    });
    assert.equal(stale.status, 409);
    assert.equal((await jsonBody(stale)).code, 'current_revision_conflict');

    const current = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'GET',
      headers: authHeader(reader.secret),
    });
    assert.deepEqual(await jsonBody(current), publishableRevision({ id: 'rev-002', html: '<h1>second</h1>' }));
  } finally {
    await mailbox.stop();
  }
});

test('publishes a revision with full metadata and lists/inspects it through the history API', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');
    const reader = await mintToken(base, ADMIN_SECRET, 'reader', 'main', 'Overlay main');

    const published = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision({ title: 'Leveling guide', description: 'Act 1 route' })),
    });
    assert.equal(published.status, 201);

    const list = await fetch(new URL('/v1/channels/main/revisions', base), { method: 'GET', headers: authHeader(reader.secret) });
    assert.equal(list.status, 200);
    const { revisions } = await jsonBody(list);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].id, 'rev-001');
    assert.equal(revisions[0].title, 'Leveling guide');
    assert.equal(revisions[0].description, 'Act 1 route');
    assert.equal(revisions[0].current, true);
    assert.equal(revisions[0].publishedBy, publisher.id);
    assert.equal(revisions[0].publishedByLabel, 'Guide bot');
    assert.equal(revisions[0].rolledBackFrom, null);
    assert.equal(typeof revisions[0].contentHash, 'string');
    assert.ok(revisions[0].contentHash.length > 0);
    assert.ok(revisions[0].createdAt > 0);
    assert.equal(revisions[0].html, undefined);

    const detail = await fetch(new URL('/v1/channels/main/revisions/rev-001', base), { method: 'GET', headers: authHeader(reader.secret) });
    assert.equal(detail.status, 200);
    const detailBody = await jsonBody(detail);
    assert.equal(detailBody.html, '<h1>hello</h1>');
    assert.equal(detailBody.current, true);
    assert.equal(detailBody.contentHash, revisions[0].contentHash);

    const missing = await fetch(new URL('/v1/channels/main/revisions/nope', base), { method: 'GET', headers: authHeader(reader.secret) });
    assert.equal(missing.status, 404);
    assert.equal((await jsonBody(missing)).code, 'revision_not_found');
  } finally {
    await mailbox.stop();
  }
});

test('rolls back to an older revision, creating a new current revision that survives restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mailbox-rollback-'));
  const databasePath = path.join(dir, 'mailbox.db');
  try {
    const first = createMailbox({ ...baseOptions(), databasePath });
    await first.start();
    let publisherSecret: string;
    let readerSecret: string;
    try {
      await createChannel(first.url, ADMIN_SECRET);
      publisherSecret = (await mintToken(first.url, ADMIN_SECRET, 'publisher', 'main', 'Guide bot')).secret;
      readerSecret = (await mintToken(first.url, ADMIN_SECRET, 'reader', 'main', 'Overlay main')).secret;

      await fetch(new URL('/v1/channels/main/revisions/current', first.url), {
        method: 'PUT',
        headers: jsonHeaders(publisherSecret),
        body: JSON.stringify(publishableRevision({ title: 'Original' })),
      });
      await fetch(new URL('/v1/channels/main/revisions/current', first.url), {
        method: 'PUT',
        headers: jsonHeaders(publisherSecret),
        body: JSON.stringify(publishableRevision({ id: 'rev-002', html: '<h1>accidental</h1>', title: 'Accidental publish' })),
      });

      const rollback = await fetch(new URL('/v1/channels/main/revisions/rev-001/rollback', first.url), {
        method: 'POST',
        headers: jsonHeaders(publisherSecret),
        body: JSON.stringify({ protocolVersion: 1, newRevisionId: 'rev-003' }),
      });
      assert.equal(rollback.status, 201);
      const rollbackBody = await jsonBody(rollback);
      assert.equal(rollbackBody.id, 'rev-003');
      assert.equal(rollbackBody.html, '<h1>hello</h1>');
      assert.equal(rollbackBody.title, 'Original');
      assert.equal(rollbackBody.rolledBackFrom, 'rev-001');
      assert.equal(rollbackBody.current, true);
    } finally {
      await first.stop();
    }

    const second = createMailbox({ ...baseOptions(), databasePath, adminBootstrapToken: undefined });
    await second.start();
    try {
      const current = await fetch(new URL('/v1/channels/main/revisions/current', second.url), {
        method: 'GET',
        headers: authHeader(readerSecret),
      });
      const currentBody = await jsonBody(current);
      assert.equal(currentBody.id, 'rev-003');
      assert.equal(currentBody.html, '<h1>hello</h1>');

      const list = await fetch(new URL('/v1/channels/main/revisions', second.url), { method: 'GET', headers: authHeader(readerSecret) });
      const { revisions } = await jsonBody(list);
      assert.deepEqual(revisions.map((r: { id: string }) => r.id), ['rev-003', 'rev-002', 'rev-001']);
      assert.equal(revisions[0].current, true);
      assert.equal(revisions[1].current, false);
      assert.equal(revisions[2].current, false);
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback respects the expected-current-revision check under concurrent modification', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');

    await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision()),
    });
    await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision({ id: 'rev-002', html: '<h1>second</h1>' })),
    });

    const stale = await fetch(new URL('/v1/channels/main/revisions/rev-001/rollback', base), {
      method: 'POST',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify({ protocolVersion: 1, newRevisionId: 'rev-003', expectedCurrentRevisionId: 'rev-001' }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await jsonBody(stale)).code, 'current_revision_conflict');

    const ok = await fetch(new URL('/v1/channels/main/revisions/rev-001/rollback', base), {
      method: 'POST',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify({ protocolVersion: 1, newRevisionId: 'rev-003', expectedCurrentRevisionId: 'rev-002' }),
    });
    assert.equal(ok.status, 201);
  } finally {
    await mailbox.stop();
  }
});

test('rejects rollback to a revision id that does not exist for the channel, and rejects it from a reader credential', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');
    const reader = await mintToken(base, ADMIN_SECRET, 'reader', 'main', 'Overlay main');

    await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision()),
    });

    const missing = await fetch(new URL('/v1/channels/main/revisions/does-not-exist/rollback', base), {
      method: 'POST',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify({ protocolVersion: 1, newRevisionId: 'rev-002' }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await jsonBody(missing)).code, 'revision_not_found');

    const forbidden = await fetch(new URL('/v1/channels/main/revisions/rev-001/rollback', base), {
      method: 'POST',
      headers: jsonHeaders(reader.secret),
      body: JSON.stringify({ protocolVersion: 1, newRevisionId: 'rev-002' }),
    });
    assert.equal(forbidden.status, 403);
  } finally {
    await mailbox.stop();
  }
});

test("reports each revision's own recorded protocol version, not the server's current constant", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mailbox-protocol-version-'));
  const databasePath = path.join(dir, 'mailbox.db');
  try {
    const first = createMailbox({ ...baseOptions(), databasePath });
    await first.start();
    let readerSecret: string;
    try {
      await createChannel(first.url, ADMIN_SECRET);
      const publisher = await mintToken(first.url, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');
      readerSecret = (await mintToken(first.url, ADMIN_SECRET, 'reader', 'main', 'Overlay main')).secret;
      await fetch(new URL('/v1/channels/main/revisions/current', first.url), {
        method: 'PUT',
        headers: jsonHeaders(publisher.secret),
        body: JSON.stringify(publishableRevision()),
      });
    } finally {
      await first.stop();
    }

    // Directly age a revision's recorded protocol version, simulating one
    // published under a since-superseded version -- not reachable through the
    // API today since there is only one supported protocolVersion.
    const db = new DatabaseSync(databasePath);
    db.exec("UPDATE revisions SET protocolVersion = 0 WHERE channel = 'main' AND id = 'rev-001'");
    db.close();

    const second = createMailbox({ ...baseOptions(), databasePath, adminBootstrapToken: undefined });
    await second.start();
    try {
      const list = await fetch(new URL('/v1/channels/main/revisions', second.url), { method: 'GET', headers: authHeader(readerSecret) });
      assert.equal((await jsonBody(list)).revisions[0].protocolVersion, 0);

      const detail = await fetch(new URL('/v1/channels/main/revisions/rev-001', second.url), { method: 'GET', headers: authHeader(readerSecret) });
      assert.equal((await jsonBody(detail)).protocolVersion, 0);

      const current = await fetch(new URL('/v1/channels/main/revisions/current', second.url), { method: 'GET', headers: authHeader(readerSecret) });
      assert.equal((await jsonBody(current)).protocolVersion, 0);
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback recomputes a content hash for a source revision published before hashing existed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mailbox-legacy-hash-'));
  const databasePath = path.join(dir, 'mailbox.db');
  try {
    const first = createMailbox({ ...baseOptions(), databasePath });
    await first.start();
    let publisherSecret: string;
    try {
      await createChannel(first.url, ADMIN_SECRET);
      publisherSecret = (await mintToken(first.url, ADMIN_SECRET, 'publisher', 'main', 'Guide bot')).secret;
      await fetch(new URL('/v1/channels/main/revisions/current', first.url), {
        method: 'PUT',
        headers: jsonHeaders(publisherSecret),
        body: JSON.stringify(publishableRevision()),
      });
      await fetch(new URL('/v1/channels/main/revisions/current', first.url), {
        method: 'PUT',
        headers: jsonHeaders(publisherSecret),
        body: JSON.stringify(publishableRevision({ id: 'rev-002', html: '<h1>second</h1>' })),
      });
    } finally {
      await first.stop();
    }

    // Simulate rev-001 having been published before migration v5 introduced
    // content hashing.
    const db = new DatabaseSync(databasePath);
    db.exec("UPDATE revisions SET content_hash = NULL WHERE channel = 'main' AND id = 'rev-001'");
    db.close();

    const second = createMailbox({ ...baseOptions(), databasePath, adminBootstrapToken: undefined });
    await second.start();
    try {
      const rollback = await fetch(new URL('/v1/channels/main/revisions/rev-001/rollback', second.url), {
        method: 'POST',
        headers: jsonHeaders(publisherSecret),
        body: JSON.stringify({ protocolVersion: 1, newRevisionId: 'rev-003' }),
      });
      assert.equal(rollback.status, 201);
      const rollbackBody = await jsonBody(rollback);
      assert.equal(typeof rollbackBody.contentHash, 'string');
      assert.ok(rollbackBody.contentHash.length > 0);
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The just-published revision is always the newest by construction, so this
// proves the 20-revision cap; it can't exercise the separate "never evict
// current regardless of rank" guard in store.ts's sweepRetention (there is no
// HTTP-reachable way to make current anything but the newest revision).
test('retains only the latest 20 revisions per channel, keeping the just-published one current', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');
    const reader = await mintToken(base, ADMIN_SECRET, 'reader', 'main', 'Overlay main');

    for (let i = 1; i <= 25; i += 1) {
      const id = `rev-${String(i).padStart(3, '0')}`;
      const response = await fetch(new URL('/v1/channels/main/revisions/current', base), {
        method: 'PUT',
        headers: jsonHeaders(publisher.secret),
        body: JSON.stringify(publishableRevision({ id, html: `<h1>${id}</h1>` })),
      });
      assert.equal(response.status, 201);
    }

    const list = await fetch(new URL('/v1/channels/main/revisions', base), { method: 'GET', headers: authHeader(reader.secret) });
    const { revisions } = await jsonBody(list);
    assert.equal(revisions.length, 20);
    assert.equal(revisions[0].id, 'rev-025');
    assert.equal(revisions[0].current, true);
    assert.equal(revisions[19].id, 'rev-006');

    const evicted = await fetch(new URL('/v1/channels/main/revisions/rev-001', base), { method: 'GET', headers: authHeader(reader.secret) });
    assert.equal(evicted.status, 404);

    const current = await fetch(new URL('/v1/channels/main/revisions/current', base), { method: 'GET', headers: authHeader(reader.secret) });
    assert.equal((await jsonBody(current)).id, 'rev-025');
  } finally {
    await mailbox.stop();
  }
});

test('notifies a paired target after a durable revision publication', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  const abort = new AbortController();
  try {
    const target = await registerTarget(base);
    const paired = await pairTarget(base, ADMIN_SECRET, target.id, target.pairingCode, 'main', 'Main channel');
    assert.equal(paired.status, 201);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');

    const events = await fetch(new URL('/v1/channels/main/events', base), {
      headers: authHeader(target.secret),
      signal: abort.signal,
    });
    assert.equal(events.status, 200);
    assert.match(events.headers.get('content-type') ?? '', /^text\/event-stream/);

    const published = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision()),
    });
    assert.equal(published.status, 201);

    const firstChunk = await events.body!.getReader().read();
    assert.equal(new TextDecoder().decode(firstChunk.value), 'event: revision\ndata: {"revisionId":"rev-001"}\n\n');

    const current = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      headers: authHeader(target.secret),
    });
    assert.equal(current.status, 200);
    assert.deepEqual(await jsonBody(current), publishableRevision());
  } finally {
    abort.abort();
    await mailbox.stop();
  }
});

test('rejects a revision for a paired channel when its profile version is incompatible', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const target = await registerTarget(base);
    const paired = await pairTarget(base, ADMIN_SECRET, target.id, target.pairingCode, 'main', 'Main channel');
    assert.equal(paired.status, 201);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');

    const rejected = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision({ profileVersion: 2 })),
    });
    assert.equal(rejected.status, 409);
    assert.equal((await jsonBody(rejected)).code, 'profile_version_mismatch');

    const current = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      headers: authHeader(target.secret),
    });
    assert.equal(current.status, 404);
    assert.equal((await jsonBody(current)).code, 'no_current_revision');
  } finally {
    await mailbox.stop();
  }
});

test('rejects unsupported protocol versions with a structured protocol error', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const badChannel = await fetch(new URL('/v1/channels', base), {
      method: 'POST',
      headers: jsonHeaders(ADMIN_SECRET),
      body: JSON.stringify({ protocolVersion: 2, id: 'bad', name: 'Bad' }),
    });
    assert.equal(badChannel.status, 400);
    const badBody = await jsonBody(badChannel);
    assert.equal(badBody.code, 'unsupported_protocol_version');
    assert.equal(badBody.protocolVersion, 1);

    await createChannel(base, ADMIN_SECRET);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');
    const badPublish = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision({ protocolVersion: 2 })),
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
  try {
    const first = createMailbox({ ...baseOptions(), databasePath });
    await first.start();
    let publisherSecret: string;
    let readerSecret: string;
    try {
      await createChannel(first.url, ADMIN_SECRET, publishableChannel('offline', 'Offline channel'));
      publisherSecret = (await mintToken(first.url, ADMIN_SECRET, 'publisher', 'offline', 'Guide bot')).secret;
      readerSecret = (await mintToken(first.url, ADMIN_SECRET, 'reader', 'offline', 'Overlay offline')).secret;
      const offlineRevision = publishableRevision({ id: 'rev-offline-1', channel: 'offline', html: '<p>offline content</p>' });
      const published = await fetch(new URL('/v1/channels/offline/revisions/current', first.url), {
        method: 'PUT',
        headers: jsonHeaders(publisherSecret),
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
        headers: authHeader(readerSecret!),
      });
      assert.equal(current.status, 200);
      assert.deepEqual(
        await jsonBody(current),
        publishableRevision({ id: 'rev-offline-1', channel: 'offline', html: '<p>offline content</p>' })
      );
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clean overlay registers as a pending target with no existing channel', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const registered = await registerTarget(base, 'Living room PC');
    assert.ok(registered.id);
    assert.ok(registered.secret.startsWith('tgt_'));
    assert.match(registered.pairingCode, /^\d{6}$/);

    const listed = await fetch(new URL('/v1/admin/targets', base), { method: 'GET', headers: authHeader(ADMIN_SECRET) });
    assert.equal(listed.status, 200);
    const body = await jsonBody(listed);
    const pending = (body.targets as Array<Record<string, unknown>>).find((t) => t.id === registered.id);
    assert.ok(pending, 'registered target should be listed as pending');
    assert.equal(pending!.clientName, 'Living room PC');
    assert.deepEqual(pending!.profile, registerableProfile());
    assert.equal('channel' in pending!, false);
    // The admin list withholds the pairing code itself; only its expiry is visible.
    assert.equal('pairingCode' in pending!, false);
    assert.equal(pending!.pairingCodeExpiresAt, registered.pairingCodeExpiresAt);
  } finally {
    await mailbox.stop();
  }
});

test('a target authenticates heartbeats with its own secret, scoped to its own id', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const target = await registerTarget(base);
    const other = await registerTarget(base, 'Other PC');

    const noAuth = await fetch(new URL(`/v1/targets/${target.id}/heartbeat`, base), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(heartbeatPayload(registerableProfile())),
    });
    assert.equal(noAuth.status, 401);

    const wrongTarget = await fetch(new URL(`/v1/targets/${target.id}/heartbeat`, base), {
      method: 'PUT',
      headers: jsonHeaders(other.secret),
      body: JSON.stringify(heartbeatPayload(registerableProfile())),
    });
    assert.equal(wrongTarget.status, 403);

    // An admin credential is not a stand-in for a target's own identity.
    const asAdmin = await fetch(new URL(`/v1/targets/${target.id}/heartbeat`, base), {
      method: 'PUT',
      headers: jsonHeaders(ADMIN_SECRET),
      body: JSON.stringify(heartbeatPayload(registerableProfile())),
    });
    assert.equal(asAdmin.status, 403);

    const ok = await fetch(new URL(`/v1/targets/${target.id}/heartbeat`, base), {
      method: 'PUT',
      headers: jsonHeaders(target.secret),
      body: JSON.stringify(heartbeatPayload(registerableProfile({ minimumTextSize: 14 }))),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await jsonBody(ok), { protocolVersion: 1, targetId: target.id, channel: null, profileVersion: 2, profileChanged: true, republishRecommended: false });
  } finally {
    await mailbox.stop();
  }
});

test('pairing creates a channel whose profile matches the live measured metrics', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const profile = registerableProfile({ contentBox: { width: 800, height: 480 } });
    const target = await registerTarget(base, 'Living room PC', profile);

    const paired = await pairTarget(base, ADMIN_SECRET, target.id, target.pairingCode, 'main', 'Main channel');
    assert.equal(paired.status, 201);
    assert.deepEqual(await jsonBody(paired), { protocolVersion: 1, id: 'main', name: 'Main channel' });

    const reader = await mintToken(base, ADMIN_SECRET, 'reader', 'main', 'Overlay main');
    const fetchedProfile = await fetch(new URL('/v1/channels/main/profile', base), { method: 'GET', headers: authHeader(reader.secret) });
    assert.equal(fetchedProfile.status, 200);
    assert.deepEqual(await jsonBody(fetchedProfile), profile);

    const heartbeat = await fetch(new URL(`/v1/targets/${target.id}/heartbeat`, base), {
      method: 'PUT',
      headers: jsonHeaders(target.secret),
      body: JSON.stringify(heartbeatPayload(profile)),
    });
    assert.deepEqual(await jsonBody(heartbeat), { protocolVersion: 1, targetId: target.id, channel: 'main', profileVersion: 1, profileChanged: false, republishRecommended: false });

    // Pairing removed it from the pending list.
    const listed = await fetch(new URL('/v1/admin/targets', base), { method: 'GET', headers: authHeader(ADMIN_SECRET) });
    const stillPending = (await jsonBody(listed)).targets.some((t: { id: string }) => t.id === target.id);
    assert.equal(stillPending, false);
  } finally {
    await mailbox.stop();
  }
});

test('reports an active render observation with exact fit metrics through the target status API', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const target = await registerTarget(base);
    const paired = await pairTarget(base, ADMIN_SECRET, target.id, target.pairingCode, 'main', 'Main channel');
    assert.equal(paired.status, 201);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');
    const published = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision()),
    });
    assert.equal(published.status, 201);

    const heartbeat = await fetch(new URL(`/v1/targets/${target.id}/heartbeat`, base), {
      method: 'PUT',
      headers: jsonHeaders(target.secret),
      body: JSON.stringify({ profile: registerableProfile(), capabilities: ['render-status'], clientVersion: '0.1.1' }),
    });
    assert.equal(heartbeat.status, 200);

    const report = await fetch(new URL(`/v1/targets/${target.id}/render-status`, base), {
      method: 'PUT',
      headers: jsonHeaders(target.secret),
      body: JSON.stringify({
        protocolVersion: 1,
        targetId: target.id,
        attemptId: 'activation-1',
        attemptStartedAt: Date.now(),
        profileVersion: 1,
        currentRevisionId: 'rev-001',
        candidateRevisionId: 'rev-001',
        rendered: { width: 960, height: 540, scrollWidth: 960, scrollHeight: 540 },
        overflow: { horizontal: false, vertical: false },
        activation: 'active',
        failureReason: null,
      }),
    });
    assert.equal(report.status, 200);

    const targetStatus = await fetch(new URL('/v1/channels/main/target', base), { headers: authHeader(target.secret) });
    assert.equal(targetStatus.status, 200);
    const targetBody = await jsonBody(targetStatus);
    assert.deepEqual({ ...targetBody, lastSeenAt: 0 }, {
      protocolVersion: 1,
      id: target.id,
      channel: 'main',
      clientName: 'Living room PC',
      profile: registerableProfile(),
      capabilities: ['render-status'],
      clientVersion: '0.1.1',
      lastSeenAt: 0,
      online: true,
      profileChangedAt: null,
      republishRecommended: false,
    });

    const status = await fetch(new URL('/v1/channels/main/render-status', base), { headers: authHeader(target.secret) });
    assert.equal(status.status, 200);
    const statusBody = await jsonBody(status);
    assert.deepEqual(
      { ...statusBody, observedAt: 0 },
      {
        protocolVersion: 1,
        targetId: target.id,
        attemptId: 'activation-1',
        attemptStartedAt: statusBody.attemptStartedAt,
        profileVersion: 1,
        currentRevisionId: 'rev-001',
        candidateRevisionId: 'rev-001',
        rendered: { width: 960, height: 540, scrollWidth: 960, scrollHeight: 540 },
        overflow: { horizontal: false, vertical: false },
        activation: 'active',
        failureReason: null,
        observedAt: 0,
        online: true,
      }
    );
    assert.equal(typeof statusBody.observedAt, 'number');
  } finally {
    await mailbox.stop();
  }
});

test('preserves stale metrics offline and distinguishes a rejected candidate after a profile change', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const target = await registerTarget(base);
    const paired = await pairTarget(base, ADMIN_SECRET, target.id, target.pairingCode, 'main', 'Main channel');
    assert.equal(paired.status, 201);
    const publisher = await mintToken(base, ADMIN_SECRET, 'publisher', 'main', 'Guide bot');
    const first = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT', headers: jsonHeaders(publisher.secret), body: JSON.stringify(publishableRevision()),
    });
    assert.equal(first.status, 201);

    const firstAttemptAt = Date.now();
    const active = await fetch(new URL(`/v1/targets/${target.id}/render-status`, base), {
      method: 'PUT',
      headers: jsonHeaders(target.secret),
      body: JSON.stringify({
        protocolVersion: 1, targetId: target.id, attemptId: 'activation-1', attemptStartedAt: firstAttemptAt,
        profileVersion: 1, currentRevisionId: 'rev-001', candidateRevisionId: 'rev-001',
        rendered: { width: 960, height: 540, scrollWidth: 960, scrollHeight: 540 },
        overflow: { horizontal: false, vertical: false }, activation: 'active', failureReason: null,
      }),
    });
    assert.equal(active.status, 200);

    const resizedProfile = registerableProfile({ contentBox: { width: 800, height: 480 } });
    const heartbeat = await fetch(new URL(`/v1/targets/${target.id}/heartbeat`, base), {
      method: 'PUT', headers: jsonHeaders(target.secret),
      body: JSON.stringify({ profile: resizedProfile, capabilities: ['render-status'], clientVersion: '0.1.1' }),
    });
    assert.deepEqual(await jsonBody(heartbeat), {
      protocolVersion: 1, targetId: target.id, channel: 'main', profileVersion: 2, profileChanged: true, republishRecommended: true,
    });

    const targetStatus = await fetch(new URL('/v1/channels/main/target', base), { headers: authHeader(target.secret) });
    const targetBody = await jsonBody(targetStatus);
    assert.equal(targetBody.profile.version, 2);
    assert.deepEqual(targetBody.profile.contentBox, { width: 800, height: 480 });
    assert.equal(targetBody.republishRecommended, true);
    assert.equal(typeof targetBody.profileChangedAt, 'number');

    const second = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT', headers: jsonHeaders(publisher.secret),
      body: JSON.stringify(publishableRevision({ id: 'rev-002', profileVersion: 2 })),
    });
    assert.equal(second.status, 201);
    const rejected = await fetch(new URL(`/v1/targets/${target.id}/render-status`, base), {
      method: 'PUT',
      headers: jsonHeaders(target.secret),
      body: JSON.stringify({
        protocolVersion: 1, targetId: target.id, attemptId: 'activation-2', attemptStartedAt: firstAttemptAt + 1,
        profileVersion: 2, currentRevisionId: 'rev-001', candidateRevisionId: 'rev-002',
        rendered: { width: 800, height: 480, scrollWidth: 920, scrollHeight: 480 },
        overflow: { horizontal: true, vertical: false }, activation: 'rejected', failureReason: 'The candidate iframe failed to stage',
      }),
    });
    assert.equal(rejected.status, 200);

    const realNow = Date.now;
    Date.now = () => realNow() + TARGET_ONLINE_WINDOW_MS + 1;
    try {
      const status = await fetch(new URL('/v1/channels/main/render-status', base), { headers: authHeader(target.secret) });
      assert.equal(status.status, 200);
      const body = await jsonBody(status);
      assert.equal(body.online, false);
      assert.equal(typeof body.observedAt, 'number');
      assert.equal(body.currentRevisionId, 'rev-001');
      assert.equal(body.candidateRevisionId, 'rev-002');
      assert.equal(body.activation, 'rejected');
      assert.equal(body.failureReason, 'The candidate iframe failed to stage');
      assert.deepEqual(body.overflow, { horizontal: true, vertical: false });
    } finally {
      Date.now = realNow;
    }
  } finally {
    await mailbox.stop();
  }
});

test('restarting the mailbox preserves an existing pairing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mailbox-target-restart-'));
  const databasePath = path.join(dir, 'mailbox.db');
  try {
    const first = createMailbox({ ...baseOptions(), databasePath });
    await first.start();
    let target: { id: string; secret: string; pairingCode: string; pairingCodeExpiresAt: number };
    try {
      target = await registerTarget(first.url);
      const paired = await pairTarget(first.url, ADMIN_SECRET, target.id, target.pairingCode, 'main', 'Main channel');
      assert.equal(paired.status, 201);
    } finally {
      await first.stop();
    }

    const second = createMailbox({ ...baseOptions(), databasePath, adminBootstrapToken: undefined });
    await second.start();
    try {
      const heartbeat = await fetch(new URL(`/v1/targets/${target.id}/heartbeat`, second.url), {
        method: 'PUT',
        headers: jsonHeaders(target.secret),
        body: JSON.stringify(heartbeatPayload(registerableProfile())),
      });
      assert.equal(heartbeat.status, 200);
      assert.deepEqual(await jsonBody(heartbeat), { protocolVersion: 1, targetId: target.id, channel: 'main', profileVersion: 1, profileChanged: false, republishRecommended: false });
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second target cannot silently attach to an already-paired channel', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const first = await registerTarget(base, 'Living room PC');
    const firstPaired = await pairTarget(base, ADMIN_SECRET, first.id, first.pairingCode, 'main', 'Main channel');
    assert.equal(firstPaired.status, 201);

    const second = await registerTarget(base, 'Bedroom PC');
    const secondAttempt = await pairTarget(base, ADMIN_SECRET, second.id, second.pairingCode, 'main', 'Main channel (again)');
    assert.equal(secondAttempt.status, 409);
    assert.equal((await jsonBody(secondAttempt)).code, 'channel_exists');

    // The first target's pairing is untouched.
    const heartbeat = await fetch(new URL(`/v1/targets/${first.id}/heartbeat`, base), {
      method: 'PUT',
      headers: jsonHeaders(first.secret),
      body: JSON.stringify(heartbeatPayload(registerableProfile())),
    });
    assert.deepEqual(await jsonBody(heartbeat), { protocolVersion: 1, targetId: first.id, channel: 'main', profileVersion: 1, profileChanged: false, republishRecommended: false });
  } finally {
    await mailbox.stop();
  }
});

test('re-pairing an already-paired target is rejected; retargeting requires explicit re-enrollment', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const target = await registerTarget(base);
    const firstPair = await pairTarget(base, ADMIN_SECRET, target.id, target.pairingCode, 'main', 'Main channel');
    assert.equal(firstPair.status, 201);

    // Retrying with the same (now-consumed) target id and code fails...
    const retry = await pairTarget(base, ADMIN_SECRET, target.id, target.pairingCode, 'other', 'Other channel');
    assert.equal(retry.status, 409);
    assert.equal((await jsonBody(retry)).code, 'target_already_paired');

    // ...but a fresh registration (explicit re-enrollment) can pair to a new channel.
    const reEnrolled = await registerTarget(base, 'Living room PC (re-enrolled)');
    const rePaired = await pairTarget(base, ADMIN_SECRET, reEnrolled.id, reEnrolled.pairingCode, 'other', 'Other channel');
    assert.equal(rePaired.status, 201);
  } finally {
    await mailbox.stop();
  }
});

test('pairing rejects an unknown target and a wrong code', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const missing = await pairTarget(base, ADMIN_SECRET, 'does-not-exist', '000000', 'main', 'Main');
    assert.equal(missing.status, 404);
    assert.equal((await jsonBody(missing)).code, 'target_not_found');

    const target = await registerTarget(base);
    const wrongCode = await pairTarget(base, ADMIN_SECRET, target.id, '000000', 'main', 'Main');
    assert.equal(wrongCode.status, 400);
    assert.equal((await jsonBody(wrongCode)).code, 'invalid_pairing_code');
  } finally {
    await mailbox.stop();
  }
});

test('pairing rejects an expired code', async () => {
  const mailbox = createMailbox({ ...baseOptions(), pairingCodeTtlMs: 1 });
  await mailbox.start();
  const base = mailbox.url;
  try {
    const target = await registerTarget(base);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const expired = await pairTarget(base, ADMIN_SECRET, target.id, target.pairingCode, 'main', 'Main');
    assert.equal(expired.status, 410);
    assert.equal((await jsonBody(expired)).code, 'pairing_code_expired');
  } finally {
    await mailbox.stop();
  }
});

test('a target credential cannot read or write channel routes it was never granted', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    await createChannel(base, ADMIN_SECRET, publishableChannel('main', 'Main'));
    const target = await registerTarget(base);

    const readChannel = await fetch(new URL('/v1/channels/main', base), { method: 'GET', headers: authHeader(target.secret) });
    assert.equal(readChannel.status, 403);

    const readProfile = await fetch(new URL('/v1/channels/main/profile', base), { method: 'GET', headers: authHeader(target.secret) });
    assert.equal(readProfile.status, 403);

    const readRevision = await fetch(new URL('/v1/channels/main/revisions/current', base), { method: 'GET', headers: authHeader(target.secret) });
    assert.equal(readRevision.status, 403);

    const publish = await fetch(new URL('/v1/channels/main/revisions/current', base), {
      method: 'PUT',
      headers: jsonHeaders(target.secret),
      body: JSON.stringify(publishableRevision()),
    });
    assert.equal(publish.status, 403);
  } finally {
    await mailbox.stop();
  }
});

test('only admin can list pending targets or pair one; registration itself needs no credential', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    // Registration is the one /v1/ write that precedes authentication.
    const target = await registerTarget(base);

    await createChannel(base, ADMIN_SECRET, publishableChannel('other', 'Other'));
    const reader = await mintToken(base, ADMIN_SECRET, 'reader', 'other', 'Overlay other');

    const listAttempt = await fetch(new URL('/v1/admin/targets', base), { method: 'GET', headers: authHeader(reader.secret) });
    assert.equal(listAttempt.status, 403);

    const pairAttempt = await pairTarget(base, reader.secret, target.id, target.pairingCode, 'main', 'Main');
    assert.equal(pairAttempt.status, 403);
  } finally {
    await mailbox.stop();
  }
});

test('rejects a malformed register-target request and an unpaired channel profile lookup', async () => {
  const mailbox = createMailbox(baseOptions());
  await mailbox.start();
  const base = mailbox.url;
  try {
    const badRegister = await fetch(new URL('/v1/targets', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientName: '', profile: registerableProfile() }),
    });
    assert.equal(badRegister.status, 400);
    assert.equal((await jsonBody(badRegister)).code, 'invalid_protocol_value');

    await createChannel(base, ADMIN_SECRET, publishableChannel('direct', 'Directly created'));
    const reader = await mintToken(base, ADMIN_SECRET, 'reader', 'direct', 'Overlay direct');
    const noProfile = await fetch(new URL('/v1/channels/direct/profile', base), { method: 'GET', headers: authHeader(reader.secret) });
    assert.equal(noProfile.status, 404);
    assert.equal((await jsonBody(noProfile)).code, 'no_profile');
  } finally {
    await mailbox.stop();
  }
});

test('serves health, readiness, and the admin UI without a credential', async () => {
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

    const admin = await fetch(new URL('/admin', base));
    assert.equal(admin.status, 200);
    assert.match(admin.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await admin.text(), /Mailbox admin/);
  } finally {
    await mailbox.stop();
  }
});
