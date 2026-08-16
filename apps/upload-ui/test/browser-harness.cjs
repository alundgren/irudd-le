const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('headless');
app.commandLine.appendSwitch('disable-gpu');

async function inspectPage(window) {
  return window.webContents.executeJavaScript(`(async () => {
    let rejectPublication = false;
    window.fetch = async (url, init) => {
      if (String(url).endsWith('/profile')) {
        return new Response(JSON.stringify({ protocolVersion: 1, version: 3, contentBox: { width: 1280, height: 720 }, devicePixelRatio: 1, screenshot: { width: 1280, height: 720 }, preferredIconSize: { min: 16, max: 32 }, minimumTextSize: 14, background: { opaque: true }, features: [] }), { status: 200 });
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
    document.getElementById('publish').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const published = document.getElementById('status').textContent;
    rejectPublication = true;
    document.getElementById('publish').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const publishError = document.getElementById('status').textContent;
    window.fetch = async () => new Response(JSON.stringify({ protocolVersion: 1, code: 'no_profile', message: 'No target' }), { status: 404 });
    set('channel', 'direct');
    document.getElementById('load-target').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { paired, published, publishError, unbound: document.getElementById('preview-status').textContent };
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
    assert.doesNotMatch(result.paired.srcdoc, /example\.test|attacker\.test|<script>|<iframe/);
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
