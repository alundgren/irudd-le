import {
  protocolErrorSchema,
  revisionSchema,
  targetProfileSchema,
  type Revision,
  type TargetProfile,
} from '@irudd-le/protocol';
import { createHash } from 'node:crypto';
import type { VerifiedAsset } from './revision-cache';

const ASSET_ID = /^[a-f0-9]{64}$/;
// Matches the mailbox's default upload ceiling. The overlay keeps the same
// upper bound while staging so a compromised or misconfigured server cannot
// turn an asset reference into unbounded local persistence.
const MAX_STAGED_ASSET_BYTES = 1024 * 1024;

export class RevisionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'RevisionApiError';
  }
}

export async function fetchCurrentRevision(
  mailboxUrl: string,
  channel: string,
  secret: string,
  signal?: AbortSignal
): Promise<Revision> {
  return request(
    mailboxUrl,
    `/v1/channels/${encodeURIComponent(channel)}/revisions/current`,
    secret,
    revisionSchema,
    signal
  );
}

/**
 * Fetches a revision's immutable assets only from its configured mailbox API.
 * Redirects are rejected so an authenticated request never travels to an
 * attacker-controlled origin.
 */
export async function fetchRevisionAssets(
  mailboxUrl: string,
  channel: string,
  secret: string,
  assetIds: readonly string[],
  signal?: AbortSignal
): Promise<VerifiedAsset[]> {
  return Promise.all(assetIds.map((assetId) => fetchRevisionAsset(mailboxUrl, channel, secret, assetId, signal)));
}

export async function fetchChannelProfile(
  mailboxUrl: string,
  channel: string,
  secret: string,
  signal?: AbortSignal
): Promise<TargetProfile> {
  return request(mailboxUrl, `/v1/channels/${encodeURIComponent(channel)}/profile`, secret, targetProfileSchema, signal);
}

export async function openRevisionEvents(
  mailboxUrl: string,
  channel: string,
  secret: string,
  signal: AbortSignal
): Promise<Response> {
  const res = await fetch(new URL(`/v1/channels/${encodeURIComponent(channel)}/events`, mailboxUrl), {
    headers: { authorization: `Bearer ${secret}` },
    signal,
  });
  if (!res.ok) throw await apiError(res);
  if (!res.body) throw new RevisionApiError(res.status, 'stream_unavailable', 'The mailbox did not provide an event stream');
  return res;
}

async function fetchRevisionAsset(
  mailboxUrl: string,
  channel: string,
  secret: string,
  assetId: string,
  signal?: AbortSignal
): Promise<VerifiedAsset> {
  if (!ASSET_ID.test(assetId)) throw new Error(`Asset '${assetId}' is not a canonical SHA-256 identifier`);
  const base = new URL(mailboxUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('Mailbox asset staging requires an HTTP(S) mailbox URL');
  const url = new URL(`/v1/channels/${encodeURIComponent(channel)}/assets/${assetId}`, base);
  if (url.origin !== base.origin) throw new Error('Asset staging may only use the configured mailbox origin');
  const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` }, redirect: 'error', signal });
  if (!res.ok) throw await apiError(res);
  const contentType = supportedAssetContentType(res.headers.get('content-type'));
  if (!contentType) throw new Error(`Asset '${assetId}' has unsupported content type '${res.headers.get('content-type') ?? 'missing'}'`);
  const declaredLength = res.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_STAGED_ASSET_BYTES)) {
    throw new Error(`Asset '${assetId}' exceeds the staging size limit`);
  }
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_STAGED_ASSET_BYTES || (declaredLength !== null && Number(declaredLength) !== data.length)) {
    throw new Error(`Asset '${assetId}' has an invalid staged length`);
  }
  if (detectAssetContentType(data) !== contentType) throw new Error(`Asset '${assetId}' content type does not match its bytes`);
  if (createHash('sha256').update(data).digest('hex') !== assetId) throw new Error(`Asset '${assetId}' content does not match its immutable identifier`);
  return { id: assetId, contentType, data };
}

async function request<T>(
  mailboxUrl: string,
  urlPath: string,
  secret: string,
  schema: { parse(value: unknown): T },
  signal?: AbortSignal
): Promise<T> {
  const res = await fetch(new URL(urlPath, mailboxUrl), {
    headers: { authorization: `Bearer ${secret}` },
    signal,
  });
  if (!res.ok) throw await apiError(res);
  return schema.parse(await res.json());
}

async function apiError(res: Response): Promise<RevisionApiError> {
  const parsed = protocolErrorSchema.safeParse(await res.json().catch(() => null));
  return parsed.success
    ? new RevisionApiError(res.status, parsed.data.code, parsed.data.message)
    : new RevisionApiError(res.status, 'request_failed', `HTTP ${res.status}`);
}

function supportedAssetContentType(value: string | null): VerifiedAsset['contentType'] | null {
  const contentType = value?.split(';', 1)[0]?.trim().toLowerCase();
  return contentType === 'image/png' || contentType === 'image/webp' ? contentType : null;
}

function detectAssetContentType(data: Buffer): VerifiedAsset['contentType'] | null {
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
