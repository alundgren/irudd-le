import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { fetchCurrentRevision, fetchRevisionAssets } from './revision-client';

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
      title: 'Hello guide',
      description: null,
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
      title: 'Hello guide',
      description: null,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('stages only authenticated, immutable PNG/WebP bytes from the configured mailbox origin', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9oZC8AAAAASUVORK5CYII=', 'base64');
  const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAABwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=', 'base64');
  const brokenPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngId = createHash('sha256').update(png).digest('hex');
  const webpId = createHash('sha256').update(webp).digest('hex');
  const brokenPngId = createHash('sha256').update(brokenPng).digest('hex');
  const server: Server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'Bearer tgt_x');
    if (req.url === `/v1/channels/main/assets/${pngId}`) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      return res.end(png);
    }
    if (req.url === `/v1/channels/main/assets/${webpId}`) {
      res.writeHead(200, { 'content-type': 'image/webp', 'content-length': webp.length });
      return res.end(webp);
    }
    assert.equal(req.url, `/v1/channels/main/assets/${brokenPngId}`);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': brokenPng.length });
    res.end(brokenPng);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const assets = await fetchRevisionAssets(`http://127.0.0.1:${port}`, 'main', 'tgt_x', [pngId, webpId]);
    assert.deepEqual(assets, [
      { id: pngId, contentType: 'image/png', data: png },
      { id: webpId, contentType: 'image/webp', data: webp },
    ]);
    await assert.rejects(
      fetchRevisionAssets(`http://127.0.0.1:${port}`, 'main', 'tgt_x', [brokenPngId]),
      /content type does not match its bytes/
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
