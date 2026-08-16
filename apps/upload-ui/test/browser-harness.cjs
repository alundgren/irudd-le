const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('headless');
app.commandLine.appendSwitch('disable-gpu');

async function inspectPage(window) {
  return window.webContents.executeJavaScript(`(async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9oZC8AAAAASUVORK5CYII='), (byte) => byte.charCodeAt(0));
    const webp = Uint8Array.from(atob('UklGRiIAAABXRUJQVlA4IBYAAABwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA='), (byte) => byte.charCodeAt(0));
    let rejectPublication = false;
    let assetUploads = 0;
    let assetFetches = 0;
    let publishedAssetIds = null;
    let publishedHtml = null;
    const assetContentTypes = new Map();
    window.fetch = async (url, init) => {
      if (String(url).endsWith('/profile')) {
        return new Response(JSON.stringify({ protocolVersion: 1, version: 3, contentBox: { width: 1280, height: 720 }, devicePixelRatio: 1, screenshot: { width: 1280, height: 720 }, preferredIconSize: { min: 16, max: 32 }, minimumTextSize: 14, background: { opaque: true }, features: [] }), { status: 200 });
      }
      if (init && init.method === 'POST' && String(url).endsWith('/assets')) {
        const id = String.fromCharCode(97 + assetUploads++).repeat(64);
        const contentType = init.headers['content-type'];
        assetContentTypes.set(id, contentType);
        return new Response(JSON.stringify({ protocolVersion: 1, id, contentType, byteLength: contentType === 'image/webp' ? webp.length : png.length, sha256: id }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('/assets/')) {
        assetFetches += 1;
        const id = String(url).split('/').at(-1);
        const contentType = assetContentTypes.get(id);
        return new Response(contentType === 'image/webp' ? webp : png, { status: 200, headers: { 'content-type': contentType } });
      }
      if (init?.method === 'PUT') {
        const publication = JSON.parse(init.body);
        publishedAssetIds = publication.assetIds;
        publishedHtml = publication.html;
      }
      return rejectPublication
        ? new Response(JSON.stringify({ protocolVersion: 1, code: 'unauthorized', message: 'A valid bearer token is required' }), { status: 401 })
        : new Response(init.body, { status: 201, headers: { 'content-type': 'application/json' } });
    };
    const set = (id, value) => { document.getElementById(id).value = value; };
    set('mailbox-url', 'https://mailbox.example/');
    set('channel', 'main');
    set('secret', 'pub_secret');
    set('title', 'Browser build');
    set('html', '<a href="https://example.test">outside</a><script>throw new Error()</script><iframe srcdoc="<meta http-equiv=refresh content=0;url=https://attacker.test>"></iframe>');
    document.getElementById('load-target').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const preview = document.getElementById('preview');
    const paired = { hidden: preview.hidden, transform: preview.style.transform, origin: preview.style.transformOrigin, srcdoc: preview.srcdoc, sandbox: preview.getAttribute('sandbox'), pointerEvents: preview.style.pointerEvents };
    const selectImage = async (name, data, type, attemptPublish = false, invalidateContext = false) => {
      const input = document.getElementById('image-file');
      Object.defineProperty(input, 'files', { configurable: true, value: [new File([data], name, { type })] });
      input.dispatchEvent(new Event('change'));
      const pendingPublishStatus = attemptPublish ? (() => {
        document.getElementById('publish').click();
        return document.getElementById('status').textContent;
      })() : null;
      if (invalidateContext) {
        set('secret', 'new_secret');
        document.getElementById('secret').dispatchEvent(new Event('input'));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return pendingPublishStatus;
    };
    const pendingPublishStatus = await selectImage('first.png', png, 'image/png', true);
    const firstAssetPreview = preview.srcdoc;
    await selectImage('second.webp', webp, 'image/webp');
    const assetPreview = preview.srcdoc;
    document.getElementById('publish').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const published = document.getElementById('status').textContent;
    rejectPublication = true;
    document.getElementById('publish').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const publishError = document.getElementById('status').textContent;
    window.dispatchEvent(new Event('beforeunload'));
    const sessionCleanedPreview = preview.srcdoc;
    await selectImage('third.png', png, 'image/png');
    const contextAssetPreview = preview.srcdoc;
    await selectImage('stale.png', png, 'image/png', false, true);
    window.fetch = async () => new Response(JSON.stringify({ protocolVersion: 1, code: 'no_profile', message: 'No target' }), { status: 404 });
    set('channel', 'direct');
    document.getElementById('channel').dispatchEvent(new Event('input'));
    const invalidatedPreview = preview.srcdoc;
    document.getElementById('load-target').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { paired, pendingPublishStatus, firstAssetPreview, assetPreview, sessionCleanedPreview, contextAssetPreview, invalidatedPreview, assetFetches, publishedAssetIds, publishedHtml, published, publishError, unbound: document.getElementById('preview-status').textContent };
  })()`);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  window.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer:${source}:${line}] ${message}`);
  });
  try {
    await window.loadFile(path.join(__dirname, '..', 'build', 'index.html'));
    const result = await inspectPage(window);
    assert.equal(result.paired.hidden, false);
    assert.match(result.paired.transform, /^scale\(/);
    assert.equal(result.paired.origin, 'left top');
    assert.equal(result.paired.sandbox, '');
    assert.equal(result.paired.pointerEvents, 'none');
    assert.match(result.paired.srcdoc, /default-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:/);
    assert.doesNotMatch(result.paired.srcdoc, /example\.test|attacker\.test|<script>|<iframe/);
    assert.equal(result.pendingPublishStatus, 'Wait for the image asset to finish uploading before publishing');
    assert.match(result.firstAssetPreview, /data-uploaded-asset="a{64}"/);
    assert.match(result.assetPreview, /data-uploaded-asset="b{64}"[^>]+src="data:image\/webp;base64,/);
    assert.doesNotMatch(result.assetPreview, /data-uploaded-asset="a{64}"/);
    assert.doesNotMatch(result.assetPreview, /example\.test|attacker\.test|<script>|<iframe/);
    assert.doesNotMatch(result.sessionCleanedPreview, /data-uploaded-asset/);
    assert.match(result.contextAssetPreview, /data-uploaded-asset="c{64}"/);
    assert.doesNotMatch(result.invalidatedPreview, /data-uploaded-asset/);
    assert.equal(result.assetFetches, 3);
    assert.deepEqual(result.publishedAssetIds, ['b'.repeat(64)]);
    assert.match(result.publishedHtml, /<img src="asset:b{64}" alt="Uploaded image">/);
    assert.match(result.published, /Published “Browser build” atomically\./);
    assert.equal(result.publishError, 'A valid bearer token is required');
    assert.match(result.unbound, /pixel-accurate preview is unavailable/);
    console.log('upload-ui browser harness passed');
  } finally {
    window.destroy();
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
