/**
 * The plain contract constants. They live apart from the schemas so that both
 * the schemas and the canonical publishing guidance can quote them without
 * importing each other; `index.ts` re-exports every one of them, so this file
 * is an internal seam, not a second public entry point.
 */

/** The only protocol version this workspace currently understands. */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Channel identifiers end up in URL paths, container volume paths, and overlay
 * enrollment codes, so they are restricted to a lowercase slug. A channel's
 * human-readable `name` stays free-form.
 */
export const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The publication bounds a client must respect, and that the guidance quotes. */
export const REVISION_TITLE_MAX_LENGTH = 200;
export const REVISION_DESCRIPTION_MAX_LENGTH = 2000;

/** Icon-heavy static guides only need these two immutable, well-understood binary formats. */
export type AssetContentType = 'image/png' | 'image/webp';

export const ASSET_CONTENT_TYPES: readonly AssetContentType[] = ['image/png', 'image/webp'];

/** The single place that knows which content-types cross the wire as an asset -- adapters (e.g. the mailbox's upload content-type header check) call this rather than repeating the list. */
export function isAssetContentType(value: unknown): value is AssetContentType {
  return typeof value === 'string' && (ASSET_CONTENT_TYPES as readonly string[]).includes(value);
}
