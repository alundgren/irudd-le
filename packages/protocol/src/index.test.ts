import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  assetSchema,
  channelListSchema,
  channelSchema,
  createTokenRequestSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  pairTargetRequestSchema,
  protocolErrorSchema,
  protocolEnvelopeSchema,
  registerTargetRequestSchema,
  renderStatusSchema,
  revisionSchema,
  rollbackRequestSchema,
  targetProfileSchema,
  targetRegistrationSchema,
} from './index';

function validProfile(): Record<string, unknown> {
  return {
    version: 1,
    contentBox: { width: 960, height: 540 },
    devicePixelRatio: 2,
    screenshot: { width: 1920, height: 1080 },
    preferredIconSize: { min: 32, max: 64 },
    minimumTextSize: 18,
    background: { opaque: false },
    features: [],
    protocolVersion: PROTOCOL_VERSION,
  };
}

test('accepts a current-version publication envelope', () => {
  const envelope = protocolEnvelopeSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    channel: 'main',
    payload: { revisionId: 'rev-001' },
  });

  assert.deepEqual(envelope, {
    protocolVersion: PROTOCOL_VERSION,
    channel: 'main',
    payload: { revisionId: 'rev-001' },
  });
});

test('rejects an unsupported protocol version explicitly', () => {
  assert.throws(
    () => protocolEnvelopeSchema.parse({ protocolVersion: 2, channel: 'main', payload: {} }),
    (error: unknown) =>
      error instanceof ProtocolValidationError &&
      error.code === 'unsupported_protocol_version' &&
      error.path === 'protocolVersion'
  );
});

test('rejects unsupported versions on every independently parsed message', () => {
  const invalidVersion = (parse: (value: unknown) => unknown, value: object): void => {
    assert.throws(
      () => parse({ ...value, protocolVersion: 2 }),
      (error: unknown) => error instanceof ProtocolValidationError && error.code === 'unsupported_protocol_version'
    );
  };

  invalidVersion(channelSchema.parse, { id: 'channel-1', name: 'main' });
  invalidVersion(assetSchema.parse, { id: 'asset-1', contentType: 'image/png', byteLength: 4, sha256: 'a'.repeat(64) });
  invalidVersion(protocolErrorSchema.parse, { code: 'invalid_content', message: 'The document did not validate.' });
  invalidVersion(renderStatusSchema.parse, {
    targetId: 'target-1', attemptId: 'attempt-1', attemptStartedAt: 1, profileVersion: 1, currentRevisionId: null, candidateRevisionId: 'rev-2',
    rendered: { width: 960, height: 540, scrollWidth: 960, scrollHeight: 540 },
    overflow: { horizontal: false, vertical: false }, activation: 'rejected', failureReason: 'stage failed',
  });
});

const NON_SLUG_IDS = ['../../etc/passwd', 'Main', 'has space', '', '-leading', 'a'.repeat(65)];

const rejectsNonSlug = (parse: (value: unknown) => unknown, base: object, key: string, path: string): void => {
  for (const id of NON_SLUG_IDS) {
    assert.throws(
      () => parse({ ...base, protocolVersion: PROTOCOL_VERSION, [key]: id }),
      (error: unknown) => error instanceof ProtocolValidationError && error.path === path,
      `expected ${path} to reject ${JSON.stringify(id)}`
    );
  }
};

test('rejects channel identifiers that are not slugs', () => {
  rejectsNonSlug(channelSchema.parse, { id: 'main', name: 'Main channel' }, 'id', 'channel.id');
  rejectsNonSlug(
    revisionSchema.parse,
    { id: 'rev-001', channel: 'main', profileVersion: 1, html: '<p>hi</p>', assetIds: [] },
    'channel',
    'revision.channel'
  );
  rejectsNonSlug(protocolEnvelopeSchema.parse, { channel: 'main', payload: {} }, 'channel', 'channel');
});

test('requires a revision title and accepts an optional description', () => {
  const base = { id: 'rev-001', channel: 'main', profileVersion: 1, protocolVersion: PROTOCOL_VERSION, html: '<p>hi</p>', assetIds: [] };

  assert.deepEqual(revisionSchema.parse({ ...base, title: 'Build guide', description: 'Leveling route' }), {
    ...base,
    title: 'Build guide',
    description: 'Leveling route',
  });
  assert.deepEqual(revisionSchema.parse({ ...base, title: 'Build guide', description: null }), {
    ...base,
    title: 'Build guide',
    description: null,
  });
  assert.deepEqual(revisionSchema.parse({ ...base, title: 'Build guide' }), {
    ...base,
    title: 'Build guide',
    description: null,
  });
  assert.deepEqual(revisionSchema.parse({ ...base, title: 'Build guide', description: '' }), {
    ...base,
    title: 'Build guide',
    description: null,
  });

  assert.throws(
    () => revisionSchema.parse({ ...base, title: '' }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'revision.title'
  );
  assert.throws(
    () => revisionSchema.parse({ ...base, title: 'x'.repeat(201) }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'revision.title'
  );
  assert.throws(
    () => revisionSchema.parse({ ...base, title: 'Build guide', description: 'x'.repeat(2001) }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'revision.description'
  );
});

test('validates a rollback request and treats an absent expected revision differently from null', () => {
  assert.deepEqual(
    rollbackRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, newRevisionId: 'rev-003' }),
    { protocolVersion: PROTOCOL_VERSION, newRevisionId: 'rev-003' }
  );
  assert.deepEqual(
    rollbackRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, newRevisionId: 'rev-003', expectedCurrentRevisionId: null }),
    { protocolVersion: PROTOCOL_VERSION, newRevisionId: 'rev-003', expectedCurrentRevisionId: null }
  );
  assert.deepEqual(
    rollbackRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, newRevisionId: 'rev-003', expectedCurrentRevisionId: 'rev-001' }),
    { protocolVersion: PROTOCOL_VERSION, newRevisionId: 'rev-003', expectedCurrentRevisionId: 'rev-001' }
  );
  assert.throws(
    () => rollbackRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, newRevisionId: 'rev-003', expectedCurrentRevisionId: '' }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'rollbackRequest.expectedCurrentRevisionId'
  );
});

test('accepts a channel name that is not a slug', () => {
  assert.deepEqual(
    channelSchema.parse({ protocolVersion: PROTOCOL_VERSION, id: 'main', name: 'Main channel' }),
    { protocolVersion: PROTOCOL_VERSION, id: 'main', name: 'Main channel' }
  );
});

test('validates the protocol-backed channel list response', () => {
  assert.deepEqual(channelListSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    channels: [{ protocolVersion: PROTOCOL_VERSION, id: 'main', name: 'Main channel' }],
  }), {
    protocolVersion: PROTOCOL_VERSION,
    channels: [{ protocolVersion: PROTOCOL_VERSION, id: 'main', name: 'Main channel' }],
  });
  assert.throws(
    () => channelListSchema.parse({ protocolVersion: PROTOCOL_VERSION, channels: [{ protocolVersion: PROTOCOL_VERSION, id: 'Not a slug', name: 'Main channel' }] }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'channel.id'
  );
});

test('validates a create-token request and requires a channel for scoped kinds', () => {
  assert.deepEqual(
    createTokenRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, kind: 'publisher', channel: 'main', label: 'Guide bot' }),
    { protocolVersion: PROTOCOL_VERSION, kind: 'publisher', channel: 'main', label: 'Guide bot' }
  );
  assert.deepEqual(
    createTokenRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, kind: 'admin', label: 'Ops' }),
    { protocolVersion: PROTOCOL_VERSION, kind: 'admin', channel: null, label: 'Ops' }
  );
  assert.throws(
    () => createTokenRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, kind: 'reader', label: 'Overlay' }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'createTokenRequest.channel'
  );
  assert.throws(
    () => createTokenRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, kind: 'admin', channel: 'main', label: 'Ops' }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'createTokenRequest.channel'
  );
  assert.throws(
    () => createTokenRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, kind: 'root', channel: 'main', label: 'x' }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'createTokenRequest.kind'
  );
});

test('validates a register-target request and rejects an oversized client name', () => {
  const request = registerTargetRequestSchema.parse({ clientName: 'Living room PC', profile: validProfile() });
  assert.equal(request.clientName, 'Living room PC');
  assert.deepEqual(request.profile, validProfile());

  assert.throws(
    () => registerTargetRequestSchema.parse({ clientName: 'x'.repeat(101), profile: validProfile() }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'registerTargetRequest.clientName'
  );
  assert.throws(
    () => registerTargetRequestSchema.parse({ clientName: 'Living room PC', profile: { ...validProfile(), protocolVersion: 2 } }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === 'unsupported_protocol_version'
  );
});

test('validates a heartbeat request against the target profile schema', () => {
  const request = heartbeatRequestSchema.parse({ profile: validProfile(), capabilities: ['render-status'], clientVersion: '0.1.1' });
  assert.deepEqual(request.profile, validProfile());
  assert.deepEqual(request.capabilities, ['render-status']);
  assert.equal(request.clientVersion, '0.1.1');

  assert.throws(
    () => heartbeatRequestSchema.parse({ profile: { ...validProfile(), contentBox: { width: 0, height: 540 } }, capabilities: [], clientVersion: '0.1.1' }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'targetProfile.contentBox.width'
  );
});

test('validates a pair-target request and rejects a non-slug channel id', () => {
  assert.deepEqual(
    pairTargetRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      pairingCode: '482913',
      channelId: 'main',
      channelName: 'Main channel',
    }),
    { protocolVersion: PROTOCOL_VERSION, pairingCode: '482913', channelId: 'main', channelName: 'Main channel' }
  );
  rejectsNonSlug(
    pairTargetRequestSchema.parse,
    { pairingCode: '482913', channelName: 'Main channel' },
    'channelId',
    'pairTargetRequest.channelId'
  );
});

test('validates a target registration response, since it gets persisted as local identity', () => {
  const registration = targetRegistrationSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    id: 'target-1',
    secret: 'tgt_abc123',
    pairingCode: '482913',
    pairingCodeExpiresAt: 123,
  });
  assert.deepEqual(registration, {
    protocolVersion: PROTOCOL_VERSION,
    id: 'target-1',
    secret: 'tgt_abc123',
    pairingCode: '482913',
    pairingCodeExpiresAt: 123,
  });
  assert.throws(
    () => targetRegistrationSchema.parse({ protocolVersion: PROTOCOL_VERSION, id: 'target-1', secret: 'x', pairingCode: '1', pairingCodeExpiresAt: 'soon' }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'targetRegistration.pairingCodeExpiresAt'
  );
});

test('validates a heartbeat response and accepts a null channel', () => {
  assert.deepEqual(
    heartbeatResponseSchema.parse({ protocolVersion: PROTOCOL_VERSION, targetId: 'target-1', channel: null, profileVersion: 1, profileChanged: false, republishRecommended: false }),
    { protocolVersion: PROTOCOL_VERSION, targetId: 'target-1', channel: null, profileVersion: 1, profileChanged: false, republishRecommended: false }
  );
  assert.deepEqual(
    heartbeatResponseSchema.parse({ protocolVersion: PROTOCOL_VERSION, targetId: 'target-1', channel: 'main', profileVersion: 2, profileChanged: true, republishRecommended: true }),
    { protocolVersion: PROTOCOL_VERSION, targetId: 'target-1', channel: 'main', profileVersion: 2, profileChanged: true, republishRecommended: true }
  );
  assert.throws(
    () => heartbeatResponseSchema.parse({ protocolVersion: PROTOCOL_VERSION, targetId: 'target-1', channel: 'Not A Slug', profileVersion: 1, profileChanged: false, republishRecommended: false }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'heartbeatResponse.channel'
  );
});

test('restricts an asset to PNG or WebP and validates its sha256 shape', () => {
  const base = { protocolVersion: PROTOCOL_VERSION, id: 'a'.repeat(64), byteLength: 4, sha256: 'a'.repeat(64) };
  assert.deepEqual(assetSchema.parse({ ...base, contentType: 'image/png' }), { ...base, contentType: 'image/png' });
  assert.deepEqual(assetSchema.parse({ ...base, contentType: 'image/webp' }), { ...base, contentType: 'image/webp' });
  assert.throws(
    () => assetSchema.parse({ ...base, contentType: 'image/gif' }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'asset.contentType'
  );
  assert.throws(
    () => assetSchema.parse({ ...base, contentType: 'image/png', sha256: 'not-hex' }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'asset.sha256'
  );
});

test('rejects a revision manifest with duplicate asset ids', () => {
  const base = { id: 'rev-001', channel: 'main', profileVersion: 1, protocolVersion: PROTOCOL_VERSION, html: '<p>hi</p>', title: 'Guide', description: null };
  assert.deepEqual(revisionSchema.parse({ ...base, assetIds: ['asset-1', 'asset-2'] }).assetIds, ['asset-1', 'asset-2']);
  assert.throws(
    () => revisionSchema.parse({ ...base, assetIds: ['asset-1', 'asset-1'] }),
    (error: unknown) => error instanceof ProtocolValidationError && error.path === 'revision.assetIds'
  );
});

test('validates a target profile at the protocol boundary', () => {
  assert.deepEqual(
    targetProfileSchema.parse({
      version: 1,
      contentBox: { width: 960, height: 540 },
      devicePixelRatio: 2,
      screenshot: { width: 1920, height: 1080 },
      preferredIconSize: { min: 32, max: 64 },
      minimumTextSize: 18,
      background: { opaque: false },
      features: ['screenshots'],
      protocolVersion: PROTOCOL_VERSION,
    }),
    {
      version: 1,
      contentBox: { width: 960, height: 540 },
      devicePixelRatio: 2,
      screenshot: { width: 1920, height: 1080 },
      preferredIconSize: { min: 32, max: 64 },
      minimumTextSize: 18,
      background: { opaque: false },
      features: ['screenshots'],
      protocolVersion: PROTOCOL_VERSION,
    }
  );
});
