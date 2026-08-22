export * from './contract.js';
export * from './guidance.js';
import {
  ASSET_CONTENT_TYPES,
  CHANNEL_ID_PATTERN,
  PROTOCOL_VERSION,
  REVISION_DESCRIPTION_MAX_LENGTH,
  REVISION_TITLE_MAX_LENGTH,
  isAssetContentType,
  type AssetContentType,
  type ProtocolVersion,
} from './contract.js';

export type ProtocolErrorCode =
  | 'invalid_protocol_value'
  | 'unsupported_protocol_version';

/** A structured validation failure that clients can safely surface. */
export class ProtocolValidationError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    readonly path: string,
    message: string
  ) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}

export interface RuntimeSchema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: ProtocolValidationError };
}

function schema<T>(parse: (value: unknown) => T): RuntimeSchema<T> {
  return {
    parse,
    safeParse(value) {
      try {
        return { success: true, data: parse(value) };
      } catch (error: unknown) {
        if (error instanceof ProtocolValidationError) {
          return { success: false, error };
        }
        throw error;
      }
    },
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(path, 'must be a non-empty string');
  }
  return value;
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  const parsed = string(value, path);
  if (parsed.length > maxLength) {
    throw invalid(path, `must be at most ${maxLength} characters`);
  }
  return parsed;
}

function number(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw invalid(path, `must be a finite number of at least ${minimum}`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  const parsed = number(value, path, minimum);
  if (!Number.isInteger(parsed)) throw invalid(path, 'must be an integer');
  return parsed;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw invalid(path, 'must be a boolean');
  return value;
}

function arrayOfStrings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw invalid(path, 'must be an array');
  return value.map((item, index) => string(item, `${path}[${index}]`));
}

function uniqueArrayOfStrings(value: unknown, path: string): string[] {
  const parsed = arrayOfStrings(value, path);
  const seen = new Set<string>();
  for (const item of parsed) {
    if (seen.has(item)) throw invalid(path, `must not contain duplicate id '${item}'`);
    seen.add(item);
  }
  return parsed;
}

function channelId(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!CHANNEL_ID_PATTERN.test(parsed)) {
    throw invalid(path, 'must be a lowercase slug of 1-64 characters (a-z, 0-9, -) starting with a letter or digit');
  }
  return parsed;
}

function invalid(path: string, message: string): ProtocolValidationError {
  return new ProtocolValidationError('invalid_protocol_value', path, `${path} ${message}`);
}

export const protocolVersionSchema = schema<ProtocolVersion>((value) => {
  if (value !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      'unsupported_protocol_version',
      'protocolVersion',
      `protocolVersion must be ${PROTOCOL_VERSION}`
    );
  }
  return PROTOCOL_VERSION;
});

/** A successful write acknowledgement with no resource payload. */
export const protocolAcknowledgementSchema = schema<ProtocolVersion>((value) => {
  const input = record(value, 'protocolAcknowledgement');
  return protocolVersionSchema.parse(input.protocolVersion);
});

export interface Channel {
  protocolVersion: ProtocolVersion;
  id: string;
  name: string;
}

export const channelSchema = schema<Channel>((value) => {
  const input = record(value, 'channel');
  return { protocolVersion: protocolVersionSchema.parse(input.protocolVersion), id: channelId(input.id, 'channel.id'), name: string(input.name, 'channel.name') };
});

/** The canonical response from the mailbox's admin-only channel-list endpoint. */
export interface ChannelList {
  protocolVersion: ProtocolVersion;
  channels: Channel[];
}

export const channelListSchema = schema<ChannelList>((value) => {
  const input = record(value, 'channelList');
  if (!Array.isArray(input.channels)) throw invalid('channelList.channels', 'must be an array');
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    channels: input.channels.map((channel) => channelSchema.parse(channel)),
  };
});

export interface TargetProfile {
  version: number;
  /** The content iframe's measured layout viewport in CSS pixels. */
  contentBox: { width: number; height: number };
  /** CSS pixels multiplied by this value give the physical-pixel capacity. */
  devicePixelRatio: number;
  /** Physical-pixel capacity, reported as round(contentBox * devicePixelRatio). */
  screenshot: { width: number; height: number };
  preferredIconSize: { min: number; max: number };
  minimumTextSize: number;
  background: { opaque: boolean };
  features: string[];
  protocolVersion: ProtocolVersion;
}

export const targetProfileSchema = schema<TargetProfile>((value) => {
  const input = record(value, 'targetProfile');
  const contentBox = record(input.contentBox, 'targetProfile.contentBox');
  const screenshot = record(input.screenshot, 'targetProfile.screenshot');
  const preferredIconSize = record(input.preferredIconSize, 'targetProfile.preferredIconSize');
  const background = record(input.background, 'targetProfile.background');
  const min = number(preferredIconSize.min, 'targetProfile.preferredIconSize.min', 1);
  const max = number(preferredIconSize.max, 'targetProfile.preferredIconSize.max', min);
  return {
    version: integer(input.version, 'targetProfile.version', 1),
    contentBox: {
      width: number(contentBox.width, 'targetProfile.contentBox.width', 1),
      height: number(contentBox.height, 'targetProfile.contentBox.height', 1),
    },
    devicePixelRatio: number(input.devicePixelRatio, 'targetProfile.devicePixelRatio', 0.1),
    screenshot: {
      width: number(screenshot.width, 'targetProfile.screenshot.width', 1),
      height: number(screenshot.height, 'targetProfile.screenshot.height', 1),
    },
    preferredIconSize: { min, max },
    minimumTextSize: number(input.minimumTextSize, 'targetProfile.minimumTextSize', 1),
    background: { opaque: boolean(background.opaque, 'targetProfile.background.opaque') },
    features: arrayOfStrings(input.features, 'targetProfile.features'),
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
  };
});

export interface RegisterTargetRequest {
  clientName: string;
  profile: TargetProfile;
}

export const registerTargetRequestSchema = schema<RegisterTargetRequest>((value) => {
  const input = record(value, 'registerTargetRequest');
  return {
    clientName: boundedString(input.clientName, 'registerTargetRequest.clientName', 100),
    profile: targetProfileSchema.parse(input.profile),
  };
});

/** Returned once, at registration; `secret` authenticates subsequent heartbeats for this target id. */
export interface TargetRegistration {
  protocolVersion: ProtocolVersion;
  id: string;
  secret: string;
  pairingCode: string;
  pairingCodeExpiresAt: number;
}

/** Validated client-side too: this response gets persisted as the overlay's local identity. */
export const targetRegistrationSchema = schema<TargetRegistration>((value) => {
  const input = record(value, 'targetRegistration');
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    id: string(input.id, 'targetRegistration.id'),
    secret: string(input.secret, 'targetRegistration.secret'),
    pairingCode: string(input.pairingCode, 'targetRegistration.pairingCode'),
    pairingCodeExpiresAt: integer(input.pairingCodeExpiresAt, 'targetRegistration.pairingCodeExpiresAt', 0),
  };
});

export interface HeartbeatRequest {
  profile: TargetProfile;
  capabilities: string[];
  clientVersion: string;
}

export const heartbeatRequestSchema = schema<HeartbeatRequest>((value) => {
  const input = record(value, 'heartbeatRequest');
  return {
    profile: targetProfileSchema.parse(input.profile),
    capabilities: arrayOfStrings(input.capabilities, 'heartbeatRequest.capabilities'),
    clientVersion: boundedString(input.clientVersion, 'heartbeatRequest.clientVersion', 100),
  };
});

export interface HeartbeatResponse {
  protocolVersion: ProtocolVersion;
  targetId: string;
  channel: string | null;
  profileVersion: number;
  profileChanged: boolean;
  republishRecommended: boolean;
}

export const heartbeatResponseSchema = schema<HeartbeatResponse>((value) => {
  const input = record(value, 'heartbeatResponse');
  if (input.channel !== null && typeof input.channel !== 'string') {
    throw invalid('heartbeatResponse.channel', 'must be a string or null');
  }
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    targetId: string(input.targetId, 'heartbeatResponse.targetId'),
    channel: input.channel === null ? null : channelId(input.channel, 'heartbeatResponse.channel'),
    profileVersion: integer(input.profileVersion, 'heartbeatResponse.profileVersion', 1),
    profileChanged: boolean(input.profileChanged, 'heartbeatResponse.profileChanged'),
    republishRecommended: boolean(input.republishRecommended, 'heartbeatResponse.republishRecommended'),
  };
});

export interface PairTargetRequest {
  protocolVersion: ProtocolVersion;
  pairingCode: string;
  channelId: string;
  channelName: string;
}

export const pairTargetRequestSchema = schema<PairTargetRequest>((value) => {
  const input = record(value, 'pairTargetRequest');
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    pairingCode: boundedString(input.pairingCode, 'pairTargetRequest.pairingCode', 32),
    channelId: channelId(input.channelId, 'pairTargetRequest.channelId'),
    channelName: string(input.channelName, 'pairTargetRequest.channelName'),
  };
});

/**
 * A pending (unpaired) target as admin sees it. The pairing code itself is
 * deliberately withheld here — it is shown only on the enrolling overlay's
 * own screen, so pairing requires a human to read it off the physical
 * device rather than trusting the admin list alone.
 */
export interface PendingTarget {
  protocolVersion: ProtocolVersion;
  id: string;
  clientName: string;
  profile: TargetProfile;
  pairingCodeExpiresAt: number | null;
  createdAt: number;
  lastSeenAt: number;
}

export const pendingTargetSchema = schema<PendingTarget>((value) => {
  const input = record(value, 'pendingTarget');
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion), id: string(input.id, 'pendingTarget.id'), clientName: string(input.clientName, 'pendingTarget.clientName'),
    profile: targetProfileSchema.parse(input.profile), pairingCodeExpiresAt: input.pairingCodeExpiresAt === null ? null : integer(input.pairingCodeExpiresAt, 'pendingTarget.pairingCodeExpiresAt', 0),
    createdAt: integer(input.createdAt, 'pendingTarget.createdAt', 0), lastSeenAt: integer(input.lastSeenAt, 'pendingTarget.lastSeenAt', 0),
  };
});

export const pendingTargetListSchema = schema<{ targets: PendingTarget[] }>((value) => {
  const input = record(value, 'pendingTargetList');
  if (!Array.isArray(input.targets)) throw invalid('pendingTargetList.targets', 'must be an array');
  return { targets: input.targets.map((target) => pendingTargetSchema.parse(target)) };
});

export interface Revision {
  id: string;
  channel: string;
  profileVersion: number;
  protocolVersion: ProtocolVersion;
  html: string;
  assetIds: string[];
  title: string;
  description: string | null;
}

/** An empty string is treated the same as absent: a UI leaving a description field blank naturally posts ''. */
function optionalBoundedString(value: unknown, path: string, maxLength: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return boundedString(value, path, maxLength);
}

export const revisionSchema = schema<Revision>((value) => {
  const input = record(value, 'revision');
  return {
    id: string(input.id, 'revision.id'),
    channel: channelId(input.channel, 'revision.channel'),
    profileVersion: integer(input.profileVersion, 'revision.profileVersion', 1),
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    html: string(input.html, 'revision.html'),
    assetIds: uniqueArrayOfStrings(input.assetIds, 'revision.assetIds'),
    title: boundedString(input.title, 'revision.title', REVISION_TITLE_MAX_LENGTH),
    description: optionalBoundedString(input.description, 'revision.description', REVISION_DESCRIPTION_MAX_LENGTH),
  };
});

/**
 * A revision publication may compare-and-swap the durable current revision.
 * Omitting `expectedCurrentRevisionId` keeps the unconditional publication
 * behaviour used by the first mailbox slice; `null` explicitly expects an
 * empty channel.
 */
export interface RevisionPublication extends Revision {
  expectedCurrentRevisionId?: string | null;
}

export const revisionPublicationSchema = schema<RevisionPublication>((value) => {
  const input = record(value, 'revisionPublication');
  const revision = revisionSchema.parse(input);
  const expected = input.expectedCurrentRevisionId;
  if (expected !== undefined && expected !== null && typeof expected !== 'string') {
    throw invalid('revisionPublication.expectedCurrentRevisionId', 'must be a string, null, or absent');
  }
  if (expected === '') {
    throw invalid('revisionPublication.expectedCurrentRevisionId', 'must be a non-empty string, null, or absent');
  }
  return expected === undefined ? revision : { ...revision, expectedCurrentRevisionId: expected };
});

/**
 * A revision as it appears in a channel's history list: everything about it
 * except the HTML body, which `RevisionDetail` adds back for the inspect
 * endpoint. Server-produced only, so (like `TokenSummary`) it has no runtime
 * schema of its own.
 */
export interface RevisionSummary {
  protocolVersion: ProtocolVersion;
  id: string;
  channel: string;
  title: string;
  description: string | null;
  profileVersion: number;
  assetIds: string[];
  /** null for a revision published before content hashing was introduced. */
  contentHash: string | null;
  publishedBy: string | null;
  publishedByLabel: string | null;
  createdAt: number;
  rolledBackFrom: string | null;
  current: boolean;
}

export interface RevisionDetail extends RevisionSummary {
  html: string;
}

export const revisionSummarySchema = schema<RevisionSummary>((value) => {
  const input = record(value, 'revisionSummary');
  const contentHash = input.contentHash;
  if (contentHash !== null && (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(contentHash))) throw invalid('revisionSummary.contentHash', 'must be a SHA-256 digest or null');
  const publishedBy = input.publishedBy;
  const publishedByLabel = input.publishedByLabel;
  if (publishedBy !== null && typeof publishedBy !== 'string') throw invalid('revisionSummary.publishedBy', 'must be a string or null');
  if (publishedByLabel !== null && typeof publishedByLabel !== 'string') throw invalid('revisionSummary.publishedByLabel', 'must be a string or null');
  if (input.rolledBackFrom !== null && typeof input.rolledBackFrom !== 'string') throw invalid('revisionSummary.rolledBackFrom', 'must be a string or null');
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion), id: string(input.id, 'revisionSummary.id'), channel: channelId(input.channel, 'revisionSummary.channel'),
    title: boundedString(input.title, 'revisionSummary.title', REVISION_TITLE_MAX_LENGTH), description: optionalBoundedString(input.description, 'revisionSummary.description', REVISION_DESCRIPTION_MAX_LENGTH),
    profileVersion: integer(input.profileVersion, 'revisionSummary.profileVersion', 1), assetIds: uniqueArrayOfStrings(input.assetIds, 'revisionSummary.assetIds'),
    contentHash, publishedBy, publishedByLabel, createdAt: integer(input.createdAt, 'revisionSummary.createdAt', 0), rolledBackFrom: input.rolledBackFrom as string | null,
    current: boolean(input.current, 'revisionSummary.current'),
  };
});

export const revisionDetailSchema = schema<RevisionDetail>((value) => {
  const input = record(value, 'revisionDetail');
  return { ...revisionSummarySchema.parse(input), html: string(input.html, 'revisionDetail.html') };
});

export const revisionListSchema = schema<{ protocolVersion: ProtocolVersion; revisions: RevisionSummary[] }>((value) => {
  const input = record(value, 'revisionList');
  if (!Array.isArray(input.revisions)) throw invalid('revisionList.revisions', 'must be an array');
  return { protocolVersion: protocolVersionSchema.parse(input.protocolVersion), revisions: input.revisions.map((revision) => revisionSummarySchema.parse(revision)) };
});

/**
 * Rollback always mints a fresh revision id for the resurrected content
 * rather than reusing the old one, since revisions are immutable and
 * `(channel, id)` is already taken. `expectedCurrentRevisionId` reuses the
 * same optional compare-and-swap shape as `RevisionPublication`.
 */
export interface RollbackRequest {
  protocolVersion: ProtocolVersion;
  newRevisionId: string;
  expectedCurrentRevisionId?: string | null;
}

export const rollbackRequestSchema = schema<RollbackRequest>((value) => {
  const input = record(value, 'rollbackRequest');
  const expected = input.expectedCurrentRevisionId;
  if (expected !== undefined && expected !== null && typeof expected !== 'string') {
    throw invalid('rollbackRequest.expectedCurrentRevisionId', 'must be a string, null, or absent');
  }
  if (expected === '') {
    throw invalid('rollbackRequest.expectedCurrentRevisionId', 'must be a non-empty string, null, or absent');
  }
  const base = {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    newRevisionId: string(input.newRevisionId, 'rollbackRequest.newRevisionId'),
  };
  return expected === undefined ? base : { ...base, expectedCurrentRevisionId: expected };
});

export interface RenderStatus {
  protocolVersion: ProtocolVersion;
  targetId: string;
  attemptId: string;
  attemptStartedAt: number;
  profileVersion: number;
  currentRevisionId: string | null;
  candidateRevisionId: string | null;
  rendered: { width: number; height: number; scrollWidth: number; scrollHeight: number };
  overflow: { horizontal: boolean; vertical: boolean };
  activation: 'active' | 'rejected';
  failureReason: string | null;
}

export const renderStatusSchema = schema<RenderStatus>((value) => {
  const input = record(value, 'renderStatus');
  const rendered = record(input.rendered, 'renderStatus.rendered');
  const overflow = record(input.overflow, 'renderStatus.overflow');
  if (input.currentRevisionId !== null && typeof input.currentRevisionId !== 'string') throw invalid('renderStatus.currentRevisionId', 'must be a string or null');
  if (input.candidateRevisionId !== null && typeof input.candidateRevisionId !== 'string') throw invalid('renderStatus.candidateRevisionId', 'must be a string or null');
  if (input.activation !== 'active' && input.activation !== 'rejected') throw invalid('renderStatus.activation', 'must be active or rejected');
  if (input.failureReason !== null && typeof input.failureReason !== 'string') throw invalid('renderStatus.failureReason', 'must be a string or null');
  if (input.activation === 'active' && (input.currentRevisionId === null || input.currentRevisionId !== input.candidateRevisionId || input.failureReason !== null)) {
    throw invalid('renderStatus', 'active observations require the candidate to be the visible revision and no failure reason');
  }
  if (input.activation === 'rejected' && (typeof input.failureReason !== 'string' || input.failureReason.length === 0)) {
    throw invalid('renderStatus.failureReason', 'must explain a rejected activation');
  }
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    targetId: string(input.targetId, 'renderStatus.targetId'),
    attemptId: boundedString(input.attemptId, 'renderStatus.attemptId', 100),
    attemptStartedAt: integer(input.attemptStartedAt, 'renderStatus.attemptStartedAt', 0),
    profileVersion: integer(input.profileVersion, 'renderStatus.profileVersion', 1),
    currentRevisionId: input.currentRevisionId,
    candidateRevisionId: input.candidateRevisionId,
    rendered: { width: number(rendered.width, 'renderStatus.rendered.width', 0), height: number(rendered.height, 'renderStatus.rendered.height', 0), scrollWidth: number(rendered.scrollWidth, 'renderStatus.rendered.scrollWidth', 0), scrollHeight: number(rendered.scrollHeight, 'renderStatus.rendered.scrollHeight', 0) },
    overflow: { horizontal: boolean(overflow.horizontal, 'renderStatus.overflow.horizontal'), vertical: boolean(overflow.vertical, 'renderStatus.overflow.vertical') },
    activation: input.activation,
    failureReason: input.failureReason,
  };
});

/** The live-or-last-known result of the canonical get_render_status operation. */
export interface RenderStatusObservation extends RenderStatus {
  observedAt: number;
  online: boolean;
}

export const renderStatusObservationSchema = schema<RenderStatusObservation>((value) => {
  const input = record(value, 'renderStatusObservation');
  const status = renderStatusSchema.parse(input);
  return {
    ...status,
    observedAt: integer(input.observedAt, 'renderStatusObservation.observedAt', 0),
    online: boolean(input.online, 'renderStatusObservation.online'),
  };
});

/** The live-or-last-known result of the canonical get_target operation. */
export interface TargetStatus {
  protocolVersion: ProtocolVersion;
  id: string;
  channel: string;
  clientName: string;
  profile: TargetProfile;
  capabilities: string[];
  clientVersion: string;
  lastSeenAt: number;
  online: boolean;
  profileChangedAt: number | null;
  republishRecommended: boolean;
}

export const targetStatusSchema = schema<TargetStatus>((value) => {
  const input = record(value, 'targetStatus');
  if (input.profileChangedAt !== null && input.profileChangedAt !== undefined && typeof input.profileChangedAt !== 'number') {
    throw invalid('targetStatus.profileChangedAt', 'must be a number or null');
  }
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    id: string(input.id, 'targetStatus.id'),
    channel: channelId(input.channel, 'targetStatus.channel'),
    clientName: string(input.clientName, 'targetStatus.clientName'),
    profile: targetProfileSchema.parse(input.profile),
    capabilities: arrayOfStrings(input.capabilities, 'targetStatus.capabilities'),
    clientVersion: boundedString(input.clientVersion, 'targetStatus.clientVersion', 100),
    lastSeenAt: integer(input.lastSeenAt, 'targetStatus.lastSeenAt', 0),
    online: boolean(input.online, 'targetStatus.online'),
    profileChangedAt: input.profileChangedAt === null || input.profileChangedAt === undefined
      ? null
      : integer(input.profileChangedAt, 'targetStatus.profileChangedAt', 0),
    republishRecommended: boolean(input.republishRecommended, 'targetStatus.republishRecommended'),
  };
});

export function assetContentType(value: unknown, path: string): AssetContentType {
  if (!isAssetContentType(value)) {
    throw invalid(path, `must be one of ${ASSET_CONTENT_TYPES.join(', ')}`);
  }
  return value;
}

export interface Asset {
  protocolVersion: ProtocolVersion;
  id: string;
  contentType: AssetContentType;
  byteLength: number;
  sha256: string;
}

export const assetSchema = schema<Asset>((value) => {
  const input = record(value, 'asset');
  const sha256 = string(input.sha256, 'asset.sha256');
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw invalid('asset.sha256', 'must be a SHA-256 digest');
  return { protocolVersion: protocolVersionSchema.parse(input.protocolVersion), id: string(input.id, 'asset.id'), contentType: assetContentType(input.contentType, 'asset.contentType'), byteLength: integer(input.byteLength, 'asset.byteLength', 0), sha256 };
});

/**
 * The three mailbox credential kinds. `admin` is unscoped; `publisher` and
 * `reader` are each bound to exactly one channel.
 */
export type TokenKind = 'admin' | 'publisher' | 'reader';

const TOKEN_KINDS: readonly TokenKind[] = ['admin', 'publisher', 'reader'];

function tokenKind(value: unknown, path: string): TokenKind {
  if (typeof value !== 'string' || !(TOKEN_KINDS as readonly string[]).includes(value)) {
    throw invalid(path, `must be one of ${TOKEN_KINDS.join(', ')}`);
  }
  return value as TokenKind;
}

export interface CreateTokenRequest {
  protocolVersion: ProtocolVersion;
  kind: TokenKind;
  channel: string | null;
  label: string;
}

export const createTokenRequestSchema = schema<CreateTokenRequest>((value) => {
  const input = record(value, 'createTokenRequest');
  const kind = tokenKind(input.kind, 'createTokenRequest.kind');
  const hasChannel = input.channel !== undefined && input.channel !== null;
  if (kind === 'admin' && hasChannel) {
    throw invalid('createTokenRequest.channel', 'must be absent for an admin token');
  }
  if (kind !== 'admin' && !hasChannel) {
    throw invalid('createTokenRequest.channel', `is required for a ${kind} token`);
  }
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    kind,
    channel: hasChannel ? channelId(input.channel, 'createTokenRequest.channel') : null,
    label: boundedString(input.label, 'createTokenRequest.label', 100),
  };
});

export interface TokenSummary {
  protocolVersion: ProtocolVersion;
  id: string;
  kind: TokenKind;
  channel: string | null;
  label: string;
  createdAt: number;
  revokedAt: number | null;
}

export const tokenSummarySchema = schema<TokenSummary>((value) => {
  const input = record(value, 'tokenSummary');
  const kind = tokenKind(input.kind, 'tokenSummary.kind');
  const hasChannel = input.channel !== undefined && input.channel !== null;
  if (kind === 'admin' && hasChannel) throw invalid('tokenSummary.channel', 'must be null for an admin token');
  if (kind !== 'admin' && !hasChannel) throw invalid('tokenSummary.channel', `is required for a ${kind} token`);
  if (input.revokedAt !== null && typeof input.revokedAt !== 'number') throw invalid('tokenSummary.revokedAt', 'must be a number or null');
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion), id: string(input.id, 'tokenSummary.id'), kind, channel: hasChannel ? channelId(input.channel, 'tokenSummary.channel') : null,
    label: boundedString(input.label, 'tokenSummary.label', 100), createdAt: integer(input.createdAt, 'tokenSummary.createdAt', 0), revokedAt: input.revokedAt === null ? null : integer(input.revokedAt, 'tokenSummary.revokedAt', 0),
  };
});

export const tokenListSchema = schema<{ tokens: TokenSummary[] }>((value) => {
  const input = record(value, 'tokenList');
  if (!Array.isArray(input.tokens)) throw invalid('tokenList.tokens', 'must be an array');
  return { tokens: input.tokens.map((token) => tokenSummarySchema.parse(token)) };
});

export interface CreatedToken extends TokenSummary {
  secret: string;
}

export const createdTokenSchema = schema<CreatedToken>((value) => {
  const input = record(value, 'createdToken');
  return { ...tokenSummarySchema.parse(input), secret: string(input.secret, 'createdToken.secret') };
});

export interface ProtocolError {
  protocolVersion: ProtocolVersion;
  code: string;
  message: string;
}

export const protocolErrorSchema = schema<ProtocolError>((value) => {
  const input = record(value, 'error');
  return { protocolVersion: protocolVersionSchema.parse(input.protocolVersion), code: string(input.code, 'error.code'), message: string(input.message, 'error.message') };
});

export interface ProtocolEnvelope {
  protocolVersion: ProtocolVersion;
  channel: string;
  payload: Record<string, unknown>;
}

export const protocolEnvelopeSchema = schema<ProtocolEnvelope>((value) => {
  const input = record(value, 'envelope');
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    channel: channelId(input.channel, 'channel'),
    payload: record(input.payload, 'payload'),
  };
});
