import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrapSource = await readFile(path.join(appRoot, 'build/renderer/measurement-bootstrap.js'), 'utf8');
const { measurementBootstrap } = await import(`data:text/javascript,${encodeURIComponent(bootstrapSource)}`);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('reports metrics only after staged images and fonts settle', async () => {
  const imageLoaded = deferred();
  const fontsLoaded = deferred();
  const messages = [];
  const image = {
    complete: false,
    naturalWidth: 1,
    addEventListener(type, listener) {
      if (type === 'load') imageLoaded.promise.then(listener);
    },
  };
  const context = {
    document: {
      images: [image],
      fonts: { ready: fontsLoaded.promise },
      documentElement: { clientWidth: 800, clientHeight: 480, scrollWidth: 920, scrollHeight: 600 },
      body: { scrollWidth: 920, scrollHeight: 600 },
    },
    parent: { postMessage: (message) => messages.push(message) },
    requestAnimationFrame: (callback) => queueMicrotask(callback),
    Promise,
  };
  Function('document', 'parent', 'requestAnimationFrame', 'Promise', measurementBootstrap('nonce-1'))(
    context.document,
    context.parent,
    context.requestAnimationFrame,
    Promise
  );

  await Promise.resolve();
  assert.deepEqual(messages, []);

  image.complete = true;
  imageLoaded.resolve();
  await Promise.resolve();
  assert.deepEqual(messages, []);

  fontsLoaded.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [{
    type: 'overlay:render-metrics',
    token: 'nonce-1',
    metrics: { width: 800, height: 480, scrollWidth: 920, scrollHeight: 600 },
  }]);
});

test('signals a staged-image decode failure instead of allowing a broken image to activate', async () => {
  const messages = [];
  const image = { complete: true, naturalWidth: 0, decode: () => Promise.reject(new Error('broken image')) };
  const context = {
    document: {
      images: [image],
      documentElement: { clientWidth: 800, clientHeight: 480, scrollWidth: 800, scrollHeight: 480 },
      body: { scrollWidth: 800, scrollHeight: 480 },
    },
    parent: { postMessage: (message) => messages.push(message) },
    requestAnimationFrame: (callback) => queueMicrotask(callback),
    Promise,
  };
  Function('document', 'parent', 'requestAnimationFrame', 'Promise', measurementBootstrap('nonce-broken'))(
    context.document,
    context.parent,
    context.requestAnimationFrame,
    Promise
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [{ type: 'overlay:render-failure', token: 'nonce-broken', error: 'broken image' }]);
});
