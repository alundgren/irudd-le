import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearCachedRevision, loadCachedRevision, revisionCacheFilePath, saveCachedRevision } from './revision-cache';

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
    saveCachedRevision(dir, CACHE_KEY, REVISION);
    assert.deepEqual(loadCachedRevision(dir, CACHE_KEY), REVISION);
    assert.equal(loadCachedRevision(dir, 'mailbox-b/target-b/main'), null);
    assert.notEqual(
      revisionCacheFilePath(dir, CACHE_KEY),
      revisionCacheFilePath(dir, 'mailbox-b/target-b/main')
    );

    const file = revisionCacheFilePath(dir, CACHE_KEY);
    const cached = JSON.parse(readFileSync(file, 'utf8')) as { revision: typeof REVISION; sha256: string };
    writeFileSync(file, JSON.stringify({ ...cached, sha256: '0'.repeat(64) }), 'utf8');
    assert.equal(loadCachedRevision(dir, CACHE_KEY), null);

    saveCachedRevision(dir, CACHE_KEY, REVISION);
    clearCachedRevision(dir);
    assert.equal(loadCachedRevision(dir, CACHE_KEY), null);
  });
});
