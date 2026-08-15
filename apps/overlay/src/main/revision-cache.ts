import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { revisionSchema, type Revision } from '@irudd-le/protocol';

interface CachedRevision {
  cacheKey: string;
  revision: Revision;
  sha256: string;
}

const FILE_PREFIX = 'revision-cache-';

export function revisionCacheFilePath(userDataDir: string, cacheKey: string): string {
  const keyHash = createHash('sha256').update(cacheKey, 'utf8').digest('hex');
  return path.join(userDataDir, `${FILE_PREFIX}${keyHash}.json`);
}

/** Returns no candidate for missing, malformed, or tampered cache data. */
export function loadCachedRevision(userDataDir: string, cacheKey: string): Revision | null {
  const file = revisionCacheFilePath(userDataDir, cacheKey);
  if (!existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const cached = value as Partial<CachedRevision>;
    const parsed = revisionSchema.safeParse(cached.revision);
    if (!parsed.success || typeof cached.sha256 !== 'string' || cached.cacheKey !== cacheKey) return null;
    return hashRevision(parsed.data) === cached.sha256 ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Writes only an activated revision, using replace-on-rename for crash safety. */
export function saveCachedRevision(userDataDir: string, cacheKey: string, revision: Revision): void {
  const file = revisionCacheFilePath(userDataDir, cacheKey);
  const canonicalRevision = revisionSchema.parse(revision);
  const cached: CachedRevision = { cacheKey, revision: canonicalRevision, sha256: hashRevision(canonicalRevision) };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cached), 'utf8');
  renameSync(tmp, file);
}

/** Explicit re-enrollment must not show a prior mailbox's cached content. */
export function clearCachedRevision(userDataDir: string): void {
  if (!existsSync(userDataDir)) return;
  for (const name of readdirSync(userDataDir)) {
    if (name.startsWith(FILE_PREFIX) && name.endsWith('.json')) {
      rmSync(path.join(userDataDir, name), { force: true });
    }
  }
}

function hashRevision(revision: Revision): string {
  return createHash('sha256').update(JSON.stringify(revision), 'utf8').digest('hex');
}
