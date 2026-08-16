import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = await readFile(path.join(appRoot, 'src/renderer/index.html'), 'utf8');
const app = await readFile(path.join(appRoot, 'src/renderer/app.ts'), 'utf8');
const assetSandbox = await readFile(path.join(appRoot, 'src/renderer/asset-sandbox.ts'), 'utf8');

test('ships a passive, sandboxed published-content frame', () => {
  assert.match(renderer, /<iframe\b[^>]*\bid=["']revision-content["']/);
  assert.match(renderer, /<iframe\b[^>]*\bsandbox(?:=["']["'])?/);
  assert.doesNotMatch(renderer, /<iframe\b[^>]*\bsandbox=["'][^"']*\ballow-(?:scripts|forms|same-origin|top-navigation)[^"']*["']/);
  assert.match(renderer, /<iframe\b[^>]*\breferrerpolicy=["']no-referrer["']/);
  assert.match(renderer, /style-src 'unsafe-inline'/);
  assert.match(renderer, /img-src data: blob:/);
  assert.match(renderer, /form-action 'none'/);
});

test('keeps normal mode content-only while retaining local recovery controls', () => {
  assert.match(renderer, /<body[^>]*data-mode=["']click-through["']/);
  assert.match(renderer, /<aside\b[^>]*\bid=["']local-setup["']/);
  assert.match(renderer, /<button\b[^>]*\bid=["']resume-content["']/);
  assert.match(renderer, /<button\b[^>]*\bid=["']quit-overlay["']/);
});

test('offers a first-run enrollment form and a pairing/retarget status view', () => {
  assert.match(renderer, /<input\b[^>]*\bid=["']mailbox-url["']/);
  assert.match(renderer, /<input\b[^>]*\bid=["']client-name["']/);
  assert.match(renderer, /<button\b[^>]*\bid=["']enroll-btn["']/);
  assert.match(renderer, /<button\b[^>]*\bid=["']re-enroll-btn["']/);
  assert.match(renderer, /<p\b[^>]*\bid=["']enrollment-detail["']/);
  assert.match(renderer, /<p\b[^>]*\bid=["']pairing-code["']/);
});

test('stages a revision off-screen and commits only a valid staged attempt', () => {
  assert.match(app, /staged\.style\.cssText = ['"]position:fixed; left:-100000px/);
  assert.match(app, /document\.body\.append\(staged\)/);
  assert.match(app, /window\.overlay\.revisions\.onStage/);
  assert.match(app, /window\.overlay\.revisions\.onCommit/);
  assert.match(app, /Date\.now\(\) > staged\.deadlineAt/);
  assert.match(app, /current\.replaceWith\(staged\.iframe\)/);
});

test('resolves immutable image references to pre-staged data URLs inside the network-denying sandbox', () => {
  assert.match(assetSandbox, /function resolveAssetUrls\(/);
  assert.match(assetSandbox, /asset:<immutable-sha256>/);
  assert.match(assetSandbox, /Required staged asset/);
  assert.match(app, /sandboxedDocument\(revision\.html, revision\.assetSources, measurementToken\)/);
  assert.match(assetSandbox, /img-src data: blob:/);
});
