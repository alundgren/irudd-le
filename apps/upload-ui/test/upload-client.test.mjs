import assert from 'node:assert/strict';
import test from 'node:test';

import { UploadClient, publishingGuideMarkup } from '../build/index.js';

const PROFILE = {
  protocolVersion: 1,
  version: 3,
  contentBox: { width: 1280, height: 720 },
  devicePixelRatio: 1,
  screenshot: { width: 1280, height: 720 },
  preferredIconSize: { min: 16, max: 32 },
  minimumTextSize: 14,
  background: { opaque: true },
  features: [],
};

function response(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('loads the paired target profile through the canonical API', async () => {
  const requests = [];
  const client = new UploadClient('https://mailbox.example/', 'pub_secret', async (input, init) => {
    requests.push([String(input), init]);
    return response(200, PROFILE);
  });

  assert.deepEqual(await client.loadTarget('main'), { state: 'paired', profile: PROFILE });
  assert.deepEqual(requests, [[
    'https://mailbox.example/v1/channels/main/profile',
    { headers: { authorization: 'Bearer pub_secret' } },
  ]]);
});

test('makes an unbound channel explicit when the canonical profile route says no_profile', async () => {
  const client = new UploadClient('https://mailbox.example/', 'pub_secret', async () => response(404, {
    protocolVersion: 1,
    code: 'no_profile',
    message: "Channel 'direct' has no target profile yet",
  }));

  assert.deepEqual(await client.loadTarget('direct'), { state: 'unbound' });
});

test('publishes exactly one validated revision and leaves errors actionable', async () => {
  const requests = [];
  const client = new UploadClient('https://mailbox.example/', 'pub_secret', async (input, init) => {
    requests.push([String(input), init]);
    return response(401, { protocolVersion: 1, code: 'unauthorized', message: 'A valid bearer token is required' });
  }, () => 'rev-31');

  await assert.rejects(
    client.publish({ channel: 'main', profileVersion: 3, title: 'Build guide', description: '', html: '<h1>Hello</h1>' }),
    (error) => error.status === 401 && error.code === 'unauthorized' && error.message === 'A valid bearer token is required'
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'https://mailbox.example/v1/channels/main/revisions/current');
  assert.deepEqual(requests[0][1].headers, { authorization: 'Bearer pub_secret', 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(requests[0][1].body), {
    protocolVersion: 1,
    id: 'rev-31',
    channel: 'main',
    profileVersion: 3,
    title: 'Build guide',
    description: null,
    html: '<h1>Hello</h1>',
    assetIds: [],
  });
});

test('returns the server-confirmed revision only after an atomic publish succeeds', async () => {
  const client = new UploadClient('https://mailbox.example/', 'pub_secret', async (_input, init) => {
    return response(201, JSON.parse(init.body));
  }, () => 'rev-32');

  assert.deepEqual(await client.publish({
    channel: 'main', profileVersion: 1, title: 'Working build', description: 'Ready to read', html: '<h1>Hello</h1>',
  }), {
    protocolVersion: 1,
    id: 'rev-32',
    channel: 'main',
    profileVersion: 1,
    title: 'Working build',
    description: 'Ready to read',
    html: '<h1>Hello</h1>',
    assetIds: [],
  });
});

test('uploads and retrieves a PNG through the authenticated mailbox asset API', async () => {
  const requests = [];
  const asset = {
    protocolVersion: 1,
    id: 'a'.repeat(64),
    contentType: 'image/png',
    byteLength: 3,
    sha256: 'a'.repeat(64),
  };
  const client = new UploadClient('https://mailbox.example/', 'pub_secret', async (input, init) => {
    requests.push([String(input), init]);
    if (init?.method === 'POST') return response(201, asset);
    return new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
  });

  const uploaded = await client.uploadAsset('main', new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' }));
  const downloaded = await client.fetchAsset('main', uploaded.id);

  assert.deepEqual(uploaded, asset);
  assert.equal(downloaded.type, 'image/png');
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), Uint8Array.from([1, 2, 3]));
  assert.equal(requests[0][0], 'https://mailbox.example/v1/channels/main/assets');
  assert.deepEqual(requests[0][1].headers, { authorization: 'Bearer pub_secret', 'content-type': 'image/png' });
  assert.equal(requests[0][1].body.type, 'image/png');
  assert.deepEqual(requests[1], [
    `https://mailbox.example/v1/channels/main/assets/${asset.id}`,
    { headers: { authorization: 'Bearer pub_secret' } },
  ]);
});

test('the on-page guidance is rendered from the canonical guide, escaped', async () => {
  const { PUBLISHING_GUIDE } = await import('@irudd-le/protocol');
  const markup = publishingGuideMarkup();

  for (const section of PUBLISHING_GUIDE.sections) {
    assert.ok(markup.includes(section.title), `the page is missing guide section '${section.title}'`);
    for (const paragraph of section.body) {
      assert.ok(markup.includes(paragraph.replaceAll('<', '&lt;').replaceAll('>', '&gt;')), `the page is missing a paragraph of '${section.id}'`);
    }
  }
  for (const step of PUBLISHING_GUIDE.exampleWorkflow) {
    assert.ok(markup.includes(step.browser), `the page is missing the browser form of '${step.purpose}'`);
    // The guidance sends a browser-path author to the CLI to read render
    // status, so the command has to be on the page, not only in CLI help.
    assert.ok(markup.includes(step.cli.join(' ')), `the page is missing the CLI form of '${step.purpose}'`);
  }
  for (const excluded of PUBLISHING_GUIDE.excludes) {
    assert.ok(markup.includes(excluded), 'the page is missing a declared exclusion');
  }
  // The guide quotes markup like <img src="asset:ID">; it must reach the page
  // as text, never as live elements inside the publishing form.
  assert.ok(!markup.includes('<img src="asset:'), 'guide markup examples must be escaped, not rendered');
});

test('the on-page guidance names the browser path constraints an author hits here', async () => {
  const markup = publishingGuideMarkup();

  assert.match(markup, /at most one image/);
  assert.match(markup, /does not report render status/);
  assert.match(markup, /universal fallback/);
});
