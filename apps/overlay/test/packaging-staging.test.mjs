import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { stageApp } from '../scripts/stage-app.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function stageIntoTempDir() {
  const staging = await mkdtemp(path.join(tmpdir(), 'overlay-staging-'));
  await stageApp({ appRoot, staging });
  return staging;
}

test('the staged app can require every runtime dependency its main process loads', async (t) => {
  const staging = await stageIntoTempDir();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const require = createRequire(path.join(staging, 'noop.cjs'));
  const { config } = require(path.join(staging, 'build', 'main', 'config.js'));

  assert.equal(config.protocolVersion, require(path.join(staging, 'node_modules', '@irudd-le', 'protocol')).PROTOCOL_VERSION);
});

test('the staged app ships no test files', async (t) => {
  const staging = await stageIntoTempDir();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const { globSync } = await import('node:fs');
  assert.deepEqual(globSync('**/*.test.js', { cwd: staging }), []);
});
