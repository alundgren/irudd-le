import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electron = require('electron');
const runner = path.join(appRoot, 'test', 'renderer-shell-stage-runner.cjs');
const hasXvfb = process.platform === 'linux' && spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status === 0;
const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...electronEnv } = process.env;

test('allows a staged revision to report metrics through the overlay shell CSP', { skip: process.platform === 'linux' && !hasXvfb && 'requires Linux with xvfb-run' }, async () => {
  const result = await new Promise((resolve, reject) => {
    const [command, args] = hasXvfb
      ? ['xvfb-run', ['-a', electron, '--no-sandbox', runner, path.join(appRoot, 'build')]]
      : [electron, ['--no-sandbox', runner, path.join(appRoot, 'build')]];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: electronEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Electron renderer test exited ${code}: ${stderr}`)));
  });
  const message = JSON.parse(result);
  assert.equal(message.type, 'overlay:render-metrics');
  assert.equal(message.token, 'shell-stage-token');
});
