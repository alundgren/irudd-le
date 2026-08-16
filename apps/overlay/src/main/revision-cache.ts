import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { revisionSchema, type Revision } from '@irudd-le/protocol';

export interface VerifiedAsset {
  id: string;
  contentType: 'image/png' | 'image/webp';
  data: Buffer;
}

export interface CachedRevision {
  revision: Revision;
  assets: VerifiedAsset[];
}

export interface CachedRevisions {
  active: CachedRevision | null;
  fallback: CachedRevision | null;
}

interface CachedRevisionRecord {
  revision: Revision;
  sha256: string;
}

interface CachedRevisionFile {
  cacheKey: string;
  active: CachedRevisionRecord;
  fallback: CachedRevisionRecord | null;
}

const FILE_PREFIX = 'revision-cache-';
const ASSET_DIR_SUFFIX = '-assets';
const ASSET_ID = /^[a-f0-9]{64}$/;

export function revisionCacheFilePath(userDataDir: string, cacheKey: string): string {
  return path.join(userDataDir, `${FILE_PREFIX}${cacheKeyHash(cacheKey)}.json`);
}

export function revisionCacheAssetDirectoryPath(userDataDir: string, cacheKey: string): string {
  return path.join(userDataDir, `${FILE_PREFIX}${cacheKeyHash(cacheKey)}${ASSET_DIR_SUFFIX}`);
}

/**
 * Returns the verified active and fallback entries independently. A corrupt or
 * incomplete entry is ignored so delivery can recover through the other one.
 */
export function loadCachedRevisions(userDataDir: string, cacheKey: string): CachedRevisions | null {
  const cached = readCacheFile(userDataDir, cacheKey);
  reconcileTemporaryCacheFiles(userDataDir, cacheKey);
  if (!cached) {
    // No validated manifest can safely name these bytes, so a failed earlier
    // write must not survive as an unbounded orphaned asset cache.
    rmSync(revisionCacheAssetDirectoryPath(userDataDir, cacheKey), { recursive: true, force: true });
    return null;
  }
  reconcileAssetDirectory(userDataDir, cacheKey, cached);
  const assetsDirectory = revisionCacheAssetDirectoryPath(userDataDir, cacheKey);
  const active = loadCachedEntry(cached.active, assetsDirectory);
  const fallback = cached.fallback ? loadCachedEntry(cached.fallback, assetsDirectory) : null;
  return { active, fallback };
}

/** Returns the active entry, or its last-known-good fallback when active bytes are incomplete. */
export function loadCachedRevision(userDataDir: string, cacheKey: string): CachedRevision | null {
  const cached = loadCachedRevisions(userDataDir, cacheKey);
  return cached?.active ?? cached?.fallback ?? null;
}

/**
 * Atomically promotes a fully verified revision. The previous active entry is
 * retained as exactly one fallback; only assets used by either entry survive.
 */
export function saveCachedRevision(
  userDataDir: string,
  cacheKey: string,
  revision: Revision,
  assets: readonly VerifiedAsset[]
): void {
  const canonicalRevision = revisionSchema.parse(revision);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  if (assetById.size !== assets.length || canonicalRevision.assetIds.some((id) => !assetById.has(id)) || assetById.size !== canonicalRevision.assetIds.length) {
    throw new Error(`Cached assets do not exactly match revision '${canonicalRevision.id}'`);
  }
  for (const asset of assets) assertVerifiedAsset(asset);

  // Reconcile the previous manifest before writing this candidate's new
  // files; otherwise that reconciliation would quite correctly treat those
  // not-yet-referenced files as strays.
  const existing = loadCachedRevisions(userDataDir, cacheKey);
  mkdirSync(userDataDir, { recursive: true });
  const assetDirectory = revisionCacheAssetDirectoryPath(userDataDir, cacheKey);
  mkdirSync(assetDirectory, { recursive: true });
  for (const asset of assets) writeAsset(assetDirectory, asset);

  const previousActive = existing?.active ?? existing?.fallback ?? null;
  const active: CachedRevisionRecord = { revision: canonicalRevision, sha256: hashRevision(canonicalRevision) };
  const fallback = previousActive && previousActive.revision.id !== canonicalRevision.id
    ? { revision: previousActive.revision, sha256: hashRevision(previousActive.revision) }
    : existing?.fallback
      ? { revision: existing.fallback.revision, sha256: hashRevision(existing.fallback.revision) }
      : null;
  const cached: CachedRevisionFile = { cacheKey, active, fallback };
  writeCacheFile(userDataDir, cacheKey, cached);
  reconcileAssetDirectory(userDataDir, cacheKey, cached);
}

/** Explicit re-enrollment must not show a prior mailbox's cached content. */
export function clearCachedRevision(userDataDir: string): void {
  if (!existsSync(userDataDir)) return;
  for (const name of readdirSync(userDataDir)) {
    if (name.startsWith(FILE_PREFIX) && (name.endsWith('.json') || name.endsWith(ASSET_DIR_SUFFIX))) {
      rmSync(path.join(userDataDir, name), { recursive: true, force: true });
    }
  }
}

function readCacheFile(userDataDir: string, cacheKey: string): CachedRevisionFile | null {
  const file = revisionCacheFilePath(userDataDir, cacheKey);
  if (!existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const cached = value as Partial<CachedRevisionFile>;
    if (cached.cacheKey !== cacheKey) return null;
    const active = parseRecord(cached.active);
    if (!active) return null;
    const fallback = cached.fallback === null || cached.fallback === undefined ? null : parseRecord(cached.fallback);
    return fallback === undefined ? null : { cacheKey, active, fallback };
  } catch {
    return null;
  }
}

function parseRecord(value: unknown): CachedRevisionRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<CachedRevisionRecord>;
  const parsed = revisionSchema.safeParse(record.revision);
  if (!parsed.success || typeof record.sha256 !== 'string' || hashRevision(parsed.data) !== record.sha256) return undefined;
  return { revision: parsed.data, sha256: record.sha256 };
}

function loadCachedEntry(record: CachedRevisionRecord, assetDirectory: string): CachedRevision | null {
  const assets: VerifiedAsset[] = [];
  for (const id of record.revision.assetIds) {
    const asset = readAsset(assetDirectory, id);
    if (!asset) return null;
    assets.push(asset);
  }
  return { revision: record.revision, assets };
}

function writeCacheFile(userDataDir: string, cacheKey: string, cached: CachedRevisionFile): void {
  const file = revisionCacheFilePath(userDataDir, cacheKey);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cached), 'utf8');
  renameSync(tmp, file);
}

function writeAsset(directory: string, asset: VerifiedAsset): void {
  const file = path.join(directory, asset.id);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, asset.data);
  renameSync(tmp, file);
}

function readAsset(directory: string, id: string): VerifiedAsset | null {
  if (!ASSET_ID.test(id)) return null;
  const file = path.join(directory, id);
  if (!existsSync(file)) return null;
  try {
    const data = readFileSync(file);
    const contentType = contentTypeFor(data);
    const hash = createHash('sha256').update(data).digest('hex');
    return contentType && hash === id ? { id, contentType, data } : null;
  } catch {
    return null;
  }
}

function reconcileAssetDirectory(userDataDir: string, cacheKey: string, cached: CachedRevisionFile): void {
  const directory = revisionCacheAssetDirectoryPath(userDataDir, cacheKey);
  if (!existsSync(directory)) return;
  const required = new Set([...cached.active.revision.assetIds, ...(cached.fallback?.revision.assetIds ?? [])]);
  for (const name of readdirSync(directory)) {
    if (!required.has(name)) rmSync(path.join(directory, name), { recursive: true, force: true });
  }
}

function reconcileTemporaryCacheFiles(userDataDir: string, cacheKey: string): void {
  if (!existsSync(userDataDir)) return;
  const fileName = path.basename(revisionCacheFilePath(userDataDir, cacheKey));
  for (const name of readdirSync(userDataDir)) {
    if (name.startsWith(`${fileName}.tmp-`)) rmSync(path.join(userDataDir, name), { force: true });
  }
}

function assertVerifiedAsset(asset: VerifiedAsset): void {
  if (!ASSET_ID.test(asset.id) || createHash('sha256').update(asset.data).digest('hex') !== asset.id || contentTypeFor(asset.data) !== asset.contentType) {
    throw new Error(`Asset '${asset.id}' is not a verified ${asset.contentType}`);
  }
}

function contentTypeFor(data: Buffer): 'image/png' | 'image/webp' | null {
  if (isPng(data)) return 'image/png';
  if (isWebp(data)) return 'image/webp';
  return null;
}

function isPng(data: Buffer): boolean {
  if (data.length < 45 || !data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  let offset = 8;
  let first = true;
  let hasImageData = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) return false;
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    if (first && (type !== 'IHDR' || length !== 13 || data.readUInt32BE(offset + 8) === 0 || data.readUInt32BE(offset + 12) === 0)) return false;
    first = false;
    if (type === 'IDAT' && length > 0) hasImageData = true;
    if (type === 'IEND') return length === 0 && hasImageData && end === data.length;
    offset = end;
  }
  return false;
}

function isWebp(data: Buffer): boolean {
  if (data.length < 20 || data.subarray(0, 4).toString('ascii') !== 'RIFF' || data.subarray(8, 12).toString('ascii') !== 'WEBP' || data.readUInt32LE(4) + 8 > data.length) return false;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const type = data.subarray(offset, offset + 4).toString('ascii');
    const length = data.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > data.length) return false;
    if ((type === 'VP8 ' && length >= 10) || (type === 'VP8L' && length >= 5) || (type === 'VP8X' && length >= 10)) return true;
    offset = end + (length % 2);
  }
  return false;
}

function cacheKeyHash(cacheKey: string): string {
  return createHash('sha256').update(cacheKey, 'utf8').digest('hex');
}

function hashRevision(revision: Revision): string {
  return createHash('sha256').update(JSON.stringify(revision), 'utf8').digest('hex');
}
