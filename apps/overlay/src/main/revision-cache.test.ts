import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearCachedRevision,
  loadCachedRevisions,
  loadCachedRevision,
  revisionCacheAssetDirectoryPath,
  revisionCacheFilePath,
  saveCachedRevision,
  type VerifiedAsset,
} from './revision-cache';

const REVISION = {
  protocolVersion: 1 as const,
  id: 'rev-001',
  channel: 'main',
  profileVersion: 1,
  html: '<h1>cached</h1>',
  assetIds: [],
  title: 'Cached guide',
  description: null,
};

const CACHE_KEY = 'mailbox-a/target-a/main';

function asset(contentType: 'image/png' | 'image/webp', data: number[]): VerifiedAsset {
  const bytes = Buffer.from(data);
  const id = createHash('sha256').update(bytes).digest('hex');
  return { id, contentType, data: bytes };
}

const PNG = asset('image/png', [...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9oZC8AAAAASUVORK5CYII=', 'base64')]);
const WEBP = asset('image/webp', [...Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAABwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=', 'base64')]);

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlay-revision-cache-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loads the last successfully activated revision only when its cache hash still matches', () => {
  withTempDir((dir) => {
    saveCachedRevision(dir, CACHE_KEY, REVISION, []);
    assert.deepEqual(loadCachedRevision(dir, CACHE_KEY)?.revision, REVISION);
    assert.equal(loadCachedRevision(dir, 'mailbox-b/target-b/main'), null);
    assert.notEqual(
      revisionCacheFilePath(dir, CACHE_KEY),
      revisionCacheFilePath(dir, 'mailbox-b/target-b/main')
    );

    const file = revisionCacheFilePath(dir, CACHE_KEY);
    const cached = JSON.parse(readFileSync(file, 'utf8')) as { active: { revision: typeof REVISION; sha256: string } };
    writeFileSync(file, JSON.stringify({ ...cached, active: { ...cached.active, sha256: '0'.repeat(64) } }), 'utf8');
    assert.equal(loadCachedRevision(dir, CACHE_KEY), null);

    saveCachedRevision(dir, CACHE_KEY, REVISION, []);
    clearCachedRevision(dir);
    assert.equal(loadCachedRevision(dir, CACHE_KEY), null);
  });
});

test('keeps verified active and fallback assets only, reconciles strays, and falls back after a restart', () => {
  withTempDir((dir) => {
    const first = { ...REVISION, id: 'rev-001', assetIds: [PNG.id] };
    const second = { ...REVISION, id: 'rev-002', assetIds: [WEBP.id] };
    saveCachedRevision(dir, CACHE_KEY, first, [PNG]);
    saveCachedRevision(dir, CACHE_KEY, second, [WEBP]);

    const stored = loadCachedRevisions(dir, CACHE_KEY);
    assert.ok(stored?.active);
    assert.deepEqual(stored.active.revision, second);
    assert.deepEqual(stored?.fallback?.revision, first);
    assert.deepEqual(stored.active.assets, [WEBP]);
    assert.deepEqual(stored?.fallback?.assets, [PNG]);

    const assetDir = revisionCacheAssetDirectoryPath(dir, CACHE_KEY);
    writeFileSync(path.join(assetDir, 'stray'), 'discard me', 'utf8');
    writeFileSync(`${revisionCacheFilePath(dir, CACHE_KEY)}.tmp-interrupted`, 'discard me', 'utf8');
    assert.deepEqual(loadCachedRevision(dir, CACHE_KEY)?.revision, second);
    assert.equal(existsSync(path.join(assetDir, 'stray')), false);
    assert.equal(existsSync(`${revisionCacheFilePath(dir, CACHE_KEY)}.tmp-interrupted`), false);

    unlinkSync(path.join(assetDir, WEBP.id));
    assert.deepEqual(loadCachedRevision(dir, CACHE_KEY)?.revision, first);
    unlinkSync(path.join(assetDir, PNG.id));
    assert.equal(loadCachedRevision(dir, CACHE_KEY), null);
  });
});
