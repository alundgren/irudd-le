/** The only protocol version this workspace currently understands. */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

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

/**
 * Channel identifiers end up in URL paths, container volume paths, and overlay
 * enrollment codes, so they are restricted to a lowercase slug. A channel's
 * human-readable `name` stays free-form.
 */
const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function channelId(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!CHANNEL_ID.test(parsed)) {
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

export interface TargetProfile {
  version: number;
  contentBox: { width: number; height: number };
  devicePixelRatio: number;
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

export interface Revision {
  id: string;
  channel: string;
  profileVersion: number;
  protocolVersion: ProtocolVersion;
  html: string;
  assetIds: string[];
}

export const revisionSchema = schema<Revision>((value) => {
  const input = record(value, 'revision');
  return {
    id: string(input.id, 'revision.id'),
    channel: channelId(input.channel, 'revision.channel'),
    profileVersion: integer(input.profileVersion, 'revision.profileVersion', 1),
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    html: string(input.html, 'revision.html'),
    assetIds: arrayOfStrings(input.assetIds, 'revision.assetIds'),
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

export interface Asset {
  protocolVersion: ProtocolVersion;
  id: string;
  contentType: string;
  byteLength: number;
  sha256: string;
}

export const assetSchema = schema<Asset>((value) => {
  const input = record(value, 'asset');
  const sha256 = string(input.sha256, 'asset.sha256');
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw invalid('asset.sha256', 'must be a SHA-256 digest');
  return { protocolVersion: protocolVersionSchema.parse(input.protocolVersion), id: string(input.id, 'asset.id'), contentType: string(input.contentType, 'asset.contentType'), byteLength: integer(input.byteLength, 'asset.byteLength', 0), sha256 };
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

export interface CreatedToken extends TokenSummary {
  secret: string;
}

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
