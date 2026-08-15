import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = await readFile(path.join(appRoot, 'src/renderer/index.html'), 'utf8');

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
