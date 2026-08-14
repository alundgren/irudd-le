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

export interface Channel {
  protocolVersion: ProtocolVersion;
  id: string;
  name: string;
}

export const channelSchema = schema<Channel>((value) => {
  const input = record(value, 'channel');
  return { protocolVersion: protocolVersionSchema.parse(input.protocolVersion), id: string(input.id, 'channel.id'), name: string(input.name, 'channel.name') };
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
    channel: string(input.channel, 'revision.channel'),
    profileVersion: integer(input.profileVersion, 'revision.profileVersion', 1),
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    html: string(input.html, 'revision.html'),
    assetIds: arrayOfStrings(input.assetIds, 'revision.assetIds'),
  };
});

export interface RenderStatus {
  protocolVersion: ProtocolVersion;
  targetId: string;
  profileVersion: number;
  currentRevisionId: string | null;
  candidateRevisionId: string | null;
  rendered: { width: number; height: number; scrollWidth: number; scrollHeight: number };
  overflow: { horizontal: boolean; vertical: boolean };
  activation: 'active' | 'rejected';
}

export const renderStatusSchema = schema<RenderStatus>((value) => {
  const input = record(value, 'renderStatus');
  const rendered = record(input.rendered, 'renderStatus.rendered');
  const overflow = record(input.overflow, 'renderStatus.overflow');
  if (input.currentRevisionId !== null && typeof input.currentRevisionId !== 'string') throw invalid('renderStatus.currentRevisionId', 'must be a string or null');
  if (input.candidateRevisionId !== null && typeof input.candidateRevisionId !== 'string') throw invalid('renderStatus.candidateRevisionId', 'must be a string or null');
  if (input.activation !== 'active' && input.activation !== 'rejected') throw invalid('renderStatus.activation', 'must be active or rejected');
  return {
    protocolVersion: protocolVersionSchema.parse(input.protocolVersion),
    targetId: string(input.targetId, 'renderStatus.targetId'),
    profileVersion: integer(input.profileVersion, 'renderStatus.profileVersion', 1),
    currentRevisionId: input.currentRevisionId,
    candidateRevisionId: input.candidateRevisionId,
    rendered: { width: number(rendered.width, 'renderStatus.rendered.width', 0), height: number(rendered.height, 'renderStatus.rendered.height', 0), scrollWidth: number(rendered.scrollWidth, 'renderStatus.rendered.scrollWidth', 0), scrollHeight: number(rendered.scrollHeight, 'renderStatus.rendered.scrollHeight', 0) },
    overflow: { horizontal: boolean(overflow.horizontal, 'renderStatus.overflow.horizontal'), vertical: boolean(overflow.vertical, 'renderStatus.overflow.vertical') },
    activation: input.activation,
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
    channel: string(input.channel, 'channel'),
    payload: record(input.payload, 'payload'),
  };
});
