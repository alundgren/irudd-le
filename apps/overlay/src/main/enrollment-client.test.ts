import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import test from 'node:test';

import type { RenderStatus, TargetProfile } from '@irudd-le/protocol';
import { EnrollmentApiError, heartbeat, registerTarget, reportRenderStatus } from './enrollment-client';

const PROFILE: TargetProfile = {
  version: 1,
  contentBox: { width: 960, height: 540 },
  devicePixelRatio: 2,
  screenshot: { width: 1920, height: 1080 },
  preferredIconSize: { min: 16, max: 48 },
  minimumTextSize: 12,
  background: { opaque: false },
  features: [],
  protocolVersion: 1,
};

async function withMockMailbox(
  handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void,
  run: (url: string) => Promise<void>
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      handler(req, res, raw.length ? JSON.parse(raw) : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('registerTarget posts client name and profile, and returns the parsed registration', async () => {
  await withMockMailbox(
    (req, res, body) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/targets');
      assert.equal(req.headers.authorization, undefined);
      assert.deepEqual(body, { clientName: 'Living room PC', profile: PROFILE });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ protocolVersion: 1, id: 'target-1', secret: 'tgt_x', pairingCode: '482913', pairingCodeExpiresAt: 123 }));
    },
    async (url) => {
      const registration = await registerTarget(url, 'Living room PC', PROFILE);
      assert.deepEqual(registration, {
        protocolVersion: 1,
        id: 'target-1',
        secret: 'tgt_x',
        pairingCode: '482913',
        pairingCodeExpiresAt: 123,
      });
    }
  );
});

test('heartbeat sends the target secret as a bearer token and reports the channel', async () => {
  await withMockMailbox(
    (req, res, body) => {
      assert.equal(req.method, 'PUT');
      assert.equal(req.url, '/v1/targets/target-1/heartbeat');
      assert.equal(req.headers.authorization, 'Bearer tgt_x');
      assert.deepEqual(body, { profile: PROFILE, capabilities: ['render-status'], clientVersion: '0.1.1' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ protocolVersion: 1, targetId: 'target-1', channel: 'main', profileVersion: 1, profileChanged: false, republishRecommended: false }));
    },
    async (url) => {
      const response = await heartbeat(url, 'target-1', 'tgt_x', PROFILE, ['render-status'], '0.1.1');
      assert.deepEqual(response, { protocolVersion: 1, targetId: 'target-1', channel: 'main', profileVersion: 1, profileChanged: false, republishRecommended: false });
    }
  );
});

test('accepts the mailbox acknowledgement after reporting render status', async () => {
  const status: RenderStatus = {
    protocolVersion: 1,
    targetId: 'target-1',
    attemptId: 'activation-1',
    attemptStartedAt: 1,
    profileVersion: 1,
    currentRevisionId: 'rev-001',
    candidateRevisionId: 'rev-001',
    rendered: { width: 960, height: 540, scrollWidth: 960, scrollHeight: 540 },
    overflow: { horizontal: false, vertical: false },
    activation: 'active',
    failureReason: null,
  };
  await withMockMailbox(
    (req, res, body) => {
      assert.equal(req.method, 'PUT');
      assert.equal(req.url, '/v1/targets/target-1/render-status');
      assert.equal(req.headers.authorization, 'Bearer tgt_x');
      assert.deepEqual(body, status);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ protocolVersion: 1 }));
    },
    (url) => reportRenderStatus(url, 'target-1', 'tgt_x', status)
  );
});

test('surfaces a mailbox error response as a typed EnrollmentApiError', async () => {
  await withMockMailbox(
    (_req, res) => {
      res.writeHead(410, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ protocolVersion: 1, code: 'pairing_code_expired', message: 'The pairing code has expired' }));
    },
    async (url) => {
      await assert.rejects(
        () => heartbeat(url, 'target-1', 'tgt_x', PROFILE, ['render-status'], '0.1.1'),
        (error: unknown) =>
          error instanceof EnrollmentApiError &&
          error.status === 410 &&
          error.code === 'pairing_code_expired' &&
          error.message === 'The pairing code has expired'
      );
    }
  );
});
