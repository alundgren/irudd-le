import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import { createMcpService } from './index';

const ADMIN_TOKEN = 'mcp-admin-token-that-must-not-leak';

interface MailboxRequest { method: string; url: string; authorization: string | undefined; contentType: string | undefined; body: Buffer }

const CHANNEL = { protocolVersion: 1, id: 'main', name: 'Main channel' };
const PROFILE = {
  protocolVersion: 1, version: 1, contentBox: { width: 960, height: 540 }, devicePixelRatio: 1,
  screenshot: { width: 960, height: 540 }, preferredIconSize: { min: 16, max: 32 }, minimumTextSize: 12, background: { opaque: false }, features: [],
};
const ASSET = { protocolVersion: 1, id: 'a'.repeat(64), contentType: 'image/png', byteLength: 8, sha256: 'a'.repeat(64) };

async function startMailboxStub(): Promise<{ url: string; requests: MailboxRequest[]; close: () => Promise<void> }> {
  const requests: MailboxRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = { method: req.method ?? 'GET', url: req.url ?? '', authorization: req.headers.authorization, contentType: req.headers['content-type'], body: Buffer.concat(chunks) };
      requests.push(request);
      const json = (value: unknown, status = 200): void => {
        const body = JSON.stringify(value);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      };
      if (request.url === '/v1/channels/forbidden') return json({ protocolVersion: 1, code: 'forbidden', message: 'Not permitted' }, 403);
      if (request.url === '/v1/channels/invalid') return json({ protocolVersion: 1, code: 'invalid_protocol_value', message: 'Malformed request' }, 400);
      if (request.url === '/v1/channels/conflict') return json({ protocolVersion: 1, code: 'channel_conflict', message: 'Concurrent change' }, 409);
      if (request.url === '/v1/channels/reflect') return json({ protocolVersion: 1, code: 'forbidden', message: `Rejected credential ${ADMIN_TOKEN}` }, 403);
      if (request.url === '/v1/channels/bad/revisions/current') return json({ ...revision(), channel: 'bad', assetIds: [ADMIN_TOKEN, ADMIN_TOKEN] });
      if (request.url === '/v1/channels' && request.method === 'GET') return json({ protocolVersion: 1, channels: [CHANNEL] });
      if (request.url === '/v1/channels/main' && request.method === 'GET') return json(CHANNEL);
      if (request.url === '/v1/channels/main/profile') return json(PROFILE);
      if (request.url === '/v1/channels/main/target') return json({ protocolVersion: 1, id: 'target-1', channel: 'main', clientName: 'Overlay', profile: PROFILE, capabilities: [], clientVersion: '1', lastSeenAt: 1, online: true, profileChangedAt: null, republishRecommended: false });
      if (request.url === '/v1/channels/main/render-status') return json({ protocolVersion: 1, targetId: 'target-1', attemptId: 'attempt-1', attemptStartedAt: 1, profileVersion: 1, currentRevisionId: null, candidateRevisionId: null, rendered: { width: 1, height: 1, scrollWidth: 1, scrollHeight: 1 }, overflow: { horizontal: false, vertical: false }, activation: 'rejected', failureReason: 'waiting', observedAt: 1, online: true });
      if (request.url === '/v1/channels/main/revisions/current') return json(revision());
      if (request.url === '/v1/channels/main/revisions') return json({ protocolVersion: 1, revisions: [] });
      if (request.url === '/v1/channels/main/revisions/rev-1') return json(revisionDetail());
      if (request.url === '/v1/channels/main/assets') return json(ASSET, 201);
      if (request.url === '/v1/admin/tokens' && request.method === 'GET') return json({ tokens: [] });
      if (request.url === '/v1/admin/tokens' && request.method === 'POST') return json({ protocolVersion: 1, id: 'credential-1', kind: 'reader', channel: 'main', label: 'test', createdAt: 1, revokedAt: null, secret: 'reader_one-time-secret' }, 201);
      if (request.url === '/v1/admin/targets') return json({ targets: [] });
      if (request.url === '/v1/admin/targets/target-1/pair') return json(CHANNEL, 201);
      if (request.url === '/v1/channels/main/revisions/rev-1/rollback') return json(revisionDetail('rev-2'), 201);
      if (request.url === '/v1/admin/tokens/credential-1' && request.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      if (request.url === '/v1/channels' && request.method === 'POST') return json(CHANNEL, 201);
      if (request.url === '/v1/channels/main/revisions/current' && request.method === 'PUT') return json(revision(), 201);
      json({ protocolVersion: 1, code: 'not_found', message: 'Not found' }, 404);
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub did not bind a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function revision(id = 'rev-1'): Record<string, unknown> {
  return { protocolVersion: 1, id, channel: 'main', profileVersion: 1, html: '<p>Guide</p>', assetIds: [], title: 'Guide', description: null };
}

function revisionDetail(id = 'rev-1'): Record<string, unknown> {
  return { ...revision(id), contentHash: 'b'.repeat(64), publishedBy: 'credential-1', publishedByLabel: 'test', createdAt: 1, rolledBackFrom: null, current: true };
}

async function rpc(base: string, id: number, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const response = await fetch(new URL('/mcp', base), {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(response.status, 200);
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    const event = (await response.text()).split('\n').find((line) => line.startsWith('data: '));
    if (!event) throw new Error('MCP SSE response did not include a data event');
    return JSON.parse(event.slice('data: '.length));
  }
  return response.json();
}

test('serves list_channels over the public stateless MCP HTTP seam', async () => {
  const mailbox = await startMailboxStub();
  const service = createMcpService({ mailboxUrl: mailbox.url, mailboxAdminToken: ADMIN_TOKEN, listen: { host: '127.0.0.1', port: 0 } });
  await service.start();
  try {
    const listedTools = await rpc(service.url, 1, 'tools/list');
    const listChannels = listedTools.result.tools.find((tool: { name: string }) => tool.name === 'list_channels');
    assert.equal(listChannels.annotations.readOnlyHint, true);

    const called = await rpc(service.url, 2, 'tools/call', { name: 'list_channels', arguments: {} });
    assert.deepEqual(called.result.structuredContent, { protocolVersion: 1, channels: [CHANNEL] });
    assert.equal(mailbox.requests.length, 1);
    assert.deepEqual(mailbox.requests[0], {
      method: 'GET', url: '/v1/channels', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: undefined, body: Buffer.alloc(0),
    });

    const originRejected = await fetch(new URL('/mcp', service.url), { method: 'POST', headers: { origin: 'https://example.test' } });
    assert.equal(originRejected.status, 403);
  } finally {
    await service.stop();
    await mailbox.close();
  }
});

test('maps every permitted mailbox operation and never sends a destructive request without confirmation', async () => {
  const mailbox = await startMailboxStub();
  const service = createMcpService({ mailboxUrl: mailbox.url, mailboxAdminToken: ADMIN_TOKEN, listen: { host: '127.0.0.1', port: 0 } });
  await service.start();
  try {
    const call = (id: number, name: string, args: Record<string, unknown> = {}) => rpc(service.url, id, 'tools/call', { name, arguments: args });
    const tools = await rpc(service.url, 1, 'tools/list');
    assert.deepEqual(tools.result.tools.map((tool: { name: string }) => tool.name).sort(), [
      'create_channel', 'create_credential', 'get_channel', 'get_channel_profile', 'get_channel_target', 'get_current_revision', 'get_render_status',
      'get_revision', 'list_channels', 'list_credentials', 'list_pending_targets', 'list_revisions', 'pair_target', 'preview_revision', 'publish_revision',
      'revoke_credential', 'rollback_revision', 'upload_asset',
    ]);
    for (const name of ['list_channels', 'get_channel', 'get_channel_profile', 'get_channel_target', 'get_render_status', 'get_current_revision', 'list_revisions', 'get_revision', 'list_credentials', 'list_pending_targets', 'preview_revision']) {
      assert.equal(tools.result.tools.find((tool: { name: string }) => tool.name === name).annotations.readOnlyHint, true);
    }
    for (const name of ['pair_target', 'rollback_revision', 'revoke_credential']) {
      assert.equal(tools.result.tools.find((tool: { name: string }) => tool.name === name).annotations.destructiveHint, true);
    }
    for (const name of ['create_channel', 'publish_revision', 'upload_asset', 'create_credential']) {
      assert.equal(tools.result.tools.find((tool: { name: string }) => tool.name === name).annotations.destructiveHint, false);
    }

    for (const [id, name, args] of [
      [2, 'get_channel', { channelId: 'main' }], [3, 'get_channel_profile', { channelId: 'main' }], [4, 'get_channel_target', { channelId: 'main' }],
      [5, 'get_render_status', { channelId: 'main' }], [6, 'get_current_revision', { channelId: 'main' }], [7, 'list_revisions', { channelId: 'main' }],
      [8, 'get_revision', { channelId: 'main', revisionId: 'rev-1' }], [9, 'list_credentials', {}], [10, 'list_pending_targets', {}],
    ] as const) {
      assert.notEqual((await call(id, name, args)).result.isError, true, `${name} should map its valid mailbox response`);
    }

    const preview = await call(11, 'preview_revision', revision());
    assert.deepEqual(preview.result.structuredContent, revision());
    const requestCountBeforeMutations = mailbox.requests.length;
    assert.notEqual((await call(12, 'create_channel', { id: 'main', name: 'Main channel' })).result.isError, true);
    assert.notEqual((await call(13, 'publish_revision', revision())).result.isError, true);
    assert.notEqual((await call(14, 'upload_asset', { channelId: 'main', contentType: 'image/png', dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') })).result.isError, true);
    const credential = await call(15, 'create_credential', { kind: 'reader', channel: 'main', label: 'test' });
    assert.equal(credential.result.structuredContent.secret, 'reader_one-time-secret');
    assert.doesNotMatch(JSON.stringify(credential), new RegExp(ADMIN_TOKEN));

    const pairConfirmation = await call(16, 'pair_target', { targetId: 'target-1', pairingCode: '123456', channelId: 'main', channelName: 'Main channel' });
    const rollbackConfirmation = await call(17, 'rollback_revision', { channelId: 'main', sourceRevisionId: 'rev-1', newRevisionId: 'rev-2' });
    const revokeConfirmation = await call(18, 'revoke_credential', { credentialId: 'credential-1' });
    assert.equal(pairConfirmation.result.structuredContent.confirmationRequired, true);
    assert.equal(rollbackConfirmation.result.structuredContent.confirmationRequired, true);
    assert.equal(revokeConfirmation.result.structuredContent.confirmationRequired, true);
    for (const [id, name, args] of [
      [30, 'pair_target', { targetId: 'target-1', pairingCode: '123456', channelId: 'main', channelName: 'Main channel', confirm: false }],
      [31, 'rollback_revision', { channelId: 'main', sourceRevisionId: 'rev-1', newRevisionId: 'rev-2', confirm: false }],
      [32, 'revoke_credential', { credentialId: 'credential-1', confirm: false }],
    ] as const) assert.equal((await call(id, name, args)).result.structuredContent.confirmationRequired, true);
    assert.equal(mailbox.requests.length, requestCountBeforeMutations + 4);

    assert.notEqual((await call(19, 'pair_target', { targetId: 'target-1', pairingCode: '123456', channelId: 'main', channelName: 'Main channel', confirm: true })).result.isError, true);
    assert.notEqual((await call(20, 'rollback_revision', { channelId: 'main', sourceRevisionId: 'rev-1', newRevisionId: 'rev-2', confirm: true })).result.isError, true);
    assert.notEqual((await call(21, 'revoke_credential', { credentialId: 'credential-1', confirm: true })).result.isError, true);

    assert.deepEqual(mailbox.requests.map(({ method, url, authorization, contentType }) => ({ method, url, authorization, contentType })), [
      { method: 'GET', url: '/v1/channels/main', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: undefined },
      { method: 'GET', url: '/v1/channels/main/profile', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: undefined },
      { method: 'GET', url: '/v1/channels/main/target', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: undefined },
      { method: 'GET', url: '/v1/channels/main/render-status', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: undefined },
      { method: 'GET', url: '/v1/channels/main/revisions/current', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: undefined },
      { method: 'GET', url: '/v1/channels/main/revisions', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: undefined },
      { method: 'GET', url: '/v1/channels/main/revisions/rev-1', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: undefined },
      { method: 'GET', url: '/v1/admin/tokens', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: undefined },
      { method: 'GET', url: '/v1/admin/targets', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: undefined },
      { method: 'POST', url: '/v1/channels', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: 'application/json' },
      { method: 'PUT', url: '/v1/channels/main/revisions/current', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: 'application/json' },
      { method: 'POST', url: '/v1/channels/main/assets', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: 'image/png' },
      { method: 'POST', url: '/v1/admin/tokens', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: 'application/json' },
      { method: 'POST', url: '/v1/admin/targets/target-1/pair', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: 'application/json' },
      { method: 'POST', url: '/v1/channels/main/revisions/rev-1/rollback', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: 'application/json' },
      { method: 'DELETE', url: '/v1/admin/tokens/credential-1', authorization: `Bearer ${ADMIN_TOKEN}`, contentType: undefined },
    ]);
    assert.deepEqual(JSON.parse(mailbox.requests[9]!.body.toString()), CHANNEL);
    assert.deepEqual(JSON.parse(mailbox.requests[10]!.body.toString()), revision());
    assert.deepEqual(mailbox.requests[11]!.body, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const laterCredentialList = await call(22, 'list_credentials');
    assert.doesNotMatch(JSON.stringify(laterCredentialList), /reader_one-time-secret/);
    assert.doesNotMatch(JSON.stringify(laterCredentialList), new RegExp(ADMIN_TOKEN));
  } finally {
    await service.stop();
    await mailbox.close();
  }
});

test('returns structured mailbox and validation failures without exposing the admin secret', async () => {
  const mailbox = await startMailboxStub();
  const service = createMcpService({ mailboxUrl: mailbox.url, mailboxAdminToken: ADMIN_TOKEN, listen: { host: '127.0.0.1', port: 0 } });
  await service.start();
  const capturedLogs: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { capturedLogs.push(values.map(String).join(' ')); };
  try {
    const call = (id: number, name: string, args: Record<string, unknown> = {}) => rpc(service.url, id, 'tools/call', { name, arguments: args });
    for (const [id, channel, code] of [[1, 'forbidden', 'forbidden'], [2, 'invalid', 'invalid_protocol_value'], [3, 'conflict', 'channel_conflict'], [4, 'reflect', 'forbidden']] as const) {
      const result = await call(id, 'get_channel', { channelId: channel });
      assert.equal(result.result.isError, true);
      assert.match(result.result.content[0].text, new RegExp(code));
      assert.doesNotMatch(JSON.stringify(result), new RegExp(ADMIN_TOKEN));
    }
    const invalidInput = await call(5, 'create_channel', { id: 'Not a slug', name: 'Invalid' });
    assert.equal(invalidInput.result.isError, true);
    assert.match(invalidInput.result.content[0].text, /Invalid input/);
    assert.equal(mailbox.requests.length, 4);
    const malformedResponse = await call(6, 'get_current_revision', { channelId: 'bad' });
    assert.equal(malformedResponse.result.isError, true);
    assert.doesNotMatch(JSON.stringify(malformedResponse), new RegExp(ADMIN_TOKEN));
    assert.doesNotMatch(capturedLogs.join('\n'), new RegExp(ADMIN_TOKEN));
  } finally {
    console.error = originalError;
    await service.stop();
    await mailbox.close();
  }

  const unreachable = createMcpService({ mailboxUrl: 'http://127.0.0.1:1', mailboxAdminToken: ADMIN_TOKEN, listen: { host: '127.0.0.1', port: 0 } });
  await unreachable.start();
  try {
    const result = await rpc(unreachable.url, 6, 'tools/call', { name: 'list_channels', arguments: {} });
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /transport_failure/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(ADMIN_TOKEN));
  } finally {
    await unreachable.stop();
  }
});

test('rejects malformed, mismatched, and oversized assets and invalid previews before mailbox I/O', async () => {
  const mailbox = await startMailboxStub();
  const service = createMcpService({ mailboxUrl: mailbox.url, mailboxAdminToken: ADMIN_TOKEN, listen: { host: '127.0.0.1', port: 0 } });
  await service.start();
  try {
    const call = (id: number, args: Record<string, unknown>) => rpc(service.url, id, 'tools/call', { name: 'upload_asset', arguments: args });
    const before = mailbox.requests.length;
    for (const [id, args] of [
      [1, { channelId: 'main', contentType: 'image/png', dataBase64: 'not base64!' }],
      [2, { channelId: 'main', contentType: 'image/webp', dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') }],
      [3, { channelId: 'main', contentType: 'image/png', dataBase64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024 * 1024)]).toString('base64') }],
    ] as const) assert.equal((await call(id, args)).result.isError, true);
    const preview = await rpc(service.url, 4, 'tools/call', { name: 'preview_revision', arguments: { ...revision(), assetIds: ['asset-1', 'asset-1'] } });
    assert.equal(preview.result.isError, true);
    assert.equal(mailbox.requests.length, before);

    const webp = Buffer.from('RIFF\u0004\u0000\u0000\u0000WEBP');
    assert.notEqual((await call(5, { channelId: 'main', contentType: 'image/webp', dataBase64: webp.toString('base64') })).result.isError, true);
    assert.equal(mailbox.requests[0]!.contentType, 'image/webp');
    assert.deepEqual(mailbox.requests[0]!.body, webp);
  } finally {
    await service.stop();
    await mailbox.close();
  }
});
