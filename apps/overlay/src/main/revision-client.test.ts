import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { fetchCurrentRevision } from './revision-client';

test('fetches and validates the durable current revision with the target credential', async () => {
  const server: Server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/channels/main/revisions/current');
    assert.equal(req.headers.authorization, 'Bearer tgt_x');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      protocolVersion: 1,
      id: 'rev-001',
      channel: 'main',
      profileVersion: 1,
      html: '<h1>hello</h1>',
      assetIds: [],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const revision = await fetchCurrentRevision(`http://127.0.0.1:${port}`, 'main', 'tgt_x');
    assert.deepEqual(revision, {
      protocolVersion: 1,
      id: 'rev-001',
      channel: 'main',
      profileVersion: 1,
      html: '<h1>hello</h1>',
      assetIds: [],
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
