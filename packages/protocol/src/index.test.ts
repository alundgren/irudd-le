import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  assetSchema,
  channelSchema,
  protocolErrorSchema,
  protocolEnvelopeSchema,
  renderStatusSchema,
  targetProfileSchema,
} from './index';

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
    targetId: 'target-1', profileVersion: 1, currentRevisionId: null, candidateRevisionId: 'rev-2',
    rendered: { width: 960, height: 540, scrollWidth: 960, scrollHeight: 540 },
    overflow: { horizontal: false, vertical: false }, activation: 'rejected',
  });
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
