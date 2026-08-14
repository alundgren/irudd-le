import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  protocolVersionSchema,
  type Revision,
  targetProfileSchema,
} from '@irudd-le/protocol';

const MAX_REQUEST_BYTES = 1_048_576;

export interface MailboxOptions {
  databasePath: string;
  bearerToken: string;
}

export interface Mailbox {
  listen(port?: number): Promise<{ port: number }>;
  close(): Promise<void>;
}

interface ChannelResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  name: string;
  currentRevisionId: string | null;
}

type RevisionResponse = Revision;

class MailboxRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createMailbox(options: MailboxOptions): Mailbox {
  const database = new DatabaseSync(options.databasePath);
  migrate(database);

  const server: Server = createServer((request, response) => {
    void handleRequest(database, options.bearerToken, request, response).catch((error: unknown) => {
      if (error instanceof ProtocolValidationError) {
        sendError(response, 400, error.code, error.message);
        return;
      }
      if (error instanceof MailboxRequestError) {
        sendError(response, 400, error.code, error.message);
        return;
      }
      sendError(response, 500, 'internal_error', error instanceof Error ? error.message : 'Unexpected error.');
    });
  });

  return {
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.off('error', reject);
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Mailbox did not bind a TCP port.'));
            return;
          }
          resolve({ port: address.port });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          database.close();
          error ? reject(error) : resolve();
        });
      });
    },
  };
}

async function handleRequest(
  database: DatabaseSync,
  bearerToken: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://mailbox.local');
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/ready') {
    sendJson(response, 200, { status: 'ready' });
    return;
  }
  if (!isAuthorized(request, bearerToken)) {
    sendError(response, 401, 'invalid_credentials', 'A valid bearer token is required.');
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/assets') {
    const asset = parseAsset(await readJson(request));
    const sha256 = createHash('sha256').update(asset.content).digest('hex');
    database.prepare('INSERT OR IGNORE INTO assets (id, content_type, sha256, content) VALUES (?, ?, ?, ?)')
      .run(sha256, asset.contentType, sha256, asset.content);
    sendJson(response, 201, {
      protocolVersion: PROTOCOL_VERSION,
      id: sha256,
      contentType: asset.contentType,
      byteLength: asset.content.length,
      sha256,
    });
    return;
  }
  const assetMatch = /^\/v1\/assets\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'GET' && assetMatch?.[1]) {
    const id = decodeURIComponent(assetMatch[1]);
    const asset = database.prepare('SELECT content_type, content FROM assets WHERE id = ?').get(id) as
      | { content_type: string; content: Buffer }
      | undefined;
    if (!asset) {
      sendError(response, 404, 'asset_not_found', `Asset ${id} does not exist.`);
      return;
    }
    response.writeHead(200, { 'content-type': asset.content_type });
    response.end(asset.content);
    return;
  }
  const revisionMatch = /^\/v1\/revisions\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'GET' && revisionMatch?.[1]) {
    const id = decodeURIComponent(revisionMatch[1]);
    const result = revision(database, id);
    if (!result) {
      sendError(response, 404, 'revision_not_found', `Revision ${id} does not exist.`);
      return;
    }
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/channels') {
    const body = await readJson(request);
    const name = parseChannelName(body);
    try {
      database.prepare('INSERT INTO channels (id, name) VALUES (?, ?)').run(name, name);
    } catch {
      sendError(response, 409, 'channel_exists', `Channel ${name} already exists.`);
      return;
    }
    sendJson(response, 201, channel(database, name));
    return;
  }
  const targetMatch = /^\/v1\/channels\/([^/]+)\/target$/.exec(url.pathname);
  if (request.method === 'PUT' && targetMatch?.[1]) {
    const channelId = decodeURIComponent(targetMatch[1]);
    const target = parseTarget(await readJson(request));
    if (!channel(database, channelId)) {
      sendError(response, 404, 'channel_not_found', `Channel ${channelId} does not exist.`);
      return;
    }
    const existingTarget = database.prepare('SELECT channel_id FROM targets WHERE id = ?').get(target.id) as
      | { channel_id: string }
      | undefined;
    if (existingTarget && existingTarget.channel_id !== channelId) {
      sendError(response, 409, 'target_already_registered', `Target ${target.id} is already registered to channel ${existingTarget.channel_id}.`);
      return;
    }
    database.prepare(`
      INSERT INTO targets (id, channel_id, profile) VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET id = excluded.id, profile = excluded.profile
    `).run(target.id, channelId, Buffer.from(JSON.stringify(target.profile)));
    sendJson(response, 201, { protocolVersion: PROTOCOL_VERSION, id: target.id, channel: channelId, profile: target.profile });
    return;
  }
  const publishMatch = /^\/v1\/channels\/([^/]+)\/revisions$/.exec(url.pathname);
  if (request.method === 'GET' && publishMatch?.[1]) {
    const channelId = decodeURIComponent(publishMatch[1]);
    if (!channel(database, channelId)) {
      sendError(response, 404, 'channel_not_found', `Channel ${channelId} does not exist.`);
      return;
    }
    const revisions = database.prepare(`
      SELECT revisions.id, revisions.profile_version
      FROM revisions WHERE channel_id = ? ORDER BY rowid
    `).all(channelId) as { id: string; profile_version: number }[];
    sendJson(response, 200, {
      protocolVersion: PROTOCOL_VERSION,
      revisions: revisions.map((item) => ({
        id: item.id,
        profileVersion: item.profile_version,
        assetIds: revisionAssetIds(database, item.id),
      })),
    });
    return;
  }
  if (request.method === 'POST' && publishMatch?.[1]) {
    const channelId = decodeURIComponent(publishMatch[1]);
    const body = parseRevision(await readJson(request));
    const published = publishRevision(database, channelId, body);
    if (!published) {
      sendError(response, 404, 'channel_not_found', `Channel ${channelId} does not exist.`);
      return;
    }
    sendJson(response, 201, published);
    return;
  }
  const channelMatch = /^\/v1\/channels\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'GET' && channelMatch?.[1]) {
    const id = decodeURIComponent(channelMatch[1]);
    const result = channel(database, id);
    if (!result) {
      sendError(response, 404, 'channel_not_found', `Channel ${id} does not exist.`);
      return;
    }
    sendJson(response, 200, result);
    return;
  }
  sendError(response, 404, 'not_found', 'No route matches this request.');
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
  `);
  const applied = database.prepare('SELECT version FROM schema_migrations WHERE version = 1').get();
  if (applied) return;
  database.exec(`
    BEGIN;
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      current_revision_id TEXT
    );
    CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      profile_version INTEGER NOT NULL,
      html BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      content_type TEXT NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      content BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revision_assets (
      revision_id TEXT NOT NULL REFERENCES revisions(id),
      asset_id TEXT NOT NULL REFERENCES assets(id),
      PRIMARY KEY (revision_id, asset_id)
    );
    CREATE TABLE IF NOT EXISTS targets (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id),
      profile BLOB NOT NULL
    );
    INSERT INTO schema_migrations (version) VALUES (1);
    COMMIT;
  `);
}

function parseChannelName(value: unknown): string {
  const input = object(value);
  protocolVersionSchema.parse(input.protocolVersion);
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > 128) {
    throw new ProtocolValidationError('invalid_protocol_value', 'name', 'name must be a non-empty string of at most 128 characters');
  }
  return input.name;
}

function channel(database: DatabaseSync, id: string): ChannelResponse | undefined {
  const row = database
    .prepare('SELECT id, name, current_revision_id FROM channels WHERE id = ?')
    .get(id) as { id: string; name: string; current_revision_id: string | null } | undefined;
  return row && {
    protocolVersion: PROTOCOL_VERSION,
    id: row.id,
    name: row.name,
    currentRevisionId: row.current_revision_id,
  };
}

function revision(database: DatabaseSync, id: string): RevisionResponse | undefined {
  const row = database.prepare(`
    SELECT id, channel_id, profile_version, CAST(html AS TEXT) AS html
    FROM revisions WHERE id = ?
  `).get(id) as { id: string; channel_id: string; profile_version: number; html: string } | undefined;
  return row && {
    protocolVersion: PROTOCOL_VERSION,
    id: row.id,
    channel: row.channel_id,
    profileVersion: row.profile_version,
    html: row.html,
    assetIds: revisionAssetIds(database, row.id),
  };
}

function revisionAssetIds(database: DatabaseSync, revisionId: string): string[] {
  return (database.prepare('SELECT asset_id FROM revision_assets WHERE revision_id = ? ORDER BY asset_id').all(revisionId) as { asset_id: string }[])
    .map((asset) => asset.asset_id);
}

function parseRevision(value: unknown): { profileVersion: number; html: string; assetIds: string[] } {
  const input = object(value);
  protocolVersionSchema.parse(input.protocolVersion);
  if (!Number.isInteger(input.profileVersion) || typeof input.profileVersion !== 'number' || input.profileVersion < 1) {
    throw new ProtocolValidationError('invalid_protocol_value', 'profileVersion', 'profileVersion must be a positive integer');
  }
  if (typeof input.html !== 'string' || input.html.length === 0) {
    throw new ProtocolValidationError('invalid_protocol_value', 'html', 'html must be a non-empty string');
  }
  if (!Array.isArray(input.assetIds) || input.assetIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new ProtocolValidationError('invalid_protocol_value', 'assetIds', 'assetIds must be an array of non-empty strings');
  }
  return { profileVersion: input.profileVersion, html: input.html, assetIds: input.assetIds };
}

function parseAsset(value: unknown): { contentType: string; content: Buffer } {
  const input = object(value);
  protocolVersionSchema.parse(input.protocolVersion);
  if (typeof input.contentType !== 'string' || input.contentType.length === 0) {
    throw new ProtocolValidationError('invalid_protocol_value', 'contentType', 'contentType must be a non-empty string');
  }
  if (typeof input.contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.contentBase64)) {
    throw new ProtocolValidationError('invalid_protocol_value', 'contentBase64', 'contentBase64 must be valid base64');
  }
  return { contentType: input.contentType, content: Buffer.from(input.contentBase64, 'base64') };
}

function parseTarget(value: unknown): { id: string; profile: ReturnType<typeof targetProfileSchema.parse> } {
  const input = object(value);
  protocolVersionSchema.parse(input.protocolVersion);
  if (typeof input.id !== 'string' || input.id.length === 0) {
    throw new ProtocolValidationError('invalid_protocol_value', 'id', 'id must be a non-empty string');
  }
  return { id: input.id, profile: targetProfileSchema.parse(input.profile) };
}

function publishRevision(
  database: DatabaseSync,
  channelId: string,
  input: { profileVersion: number; html: string; assetIds: string[] },
): RevisionResponse | undefined {
  const existing = database.prepare('SELECT id FROM channels WHERE id = ?').get(channelId) as { id: string } | undefined;
  if (!existing) return undefined;
  const next = database.prepare('SELECT COUNT(*) AS count FROM revisions WHERE channel_id = ?').get(channelId) as { count: number };
  const id = `${channelId}:${next.count + 1}`;
  database.exec('BEGIN');
  try {
    for (const assetId of input.assetIds) {
      const asset = database.prepare('SELECT id FROM assets WHERE id = ?').get(assetId);
      if (!asset) throw new MailboxRequestError('asset_not_found', `Asset ${assetId} does not exist.`);
    }
    database.prepare('INSERT INTO revisions (id, channel_id, profile_version, html) VALUES (?, ?, ?, ?)')
      .run(id, channelId, input.profileVersion, Buffer.from(input.html));
    const linkedAssetIds = new Set<string>();
    for (const assetId of input.assetIds) {
      if (linkedAssetIds.has(assetId)) {
        throw new MailboxRequestError('duplicate_asset_id', `assetIds must not repeat ${assetId}`);
      }
      database.prepare('INSERT INTO revision_assets (revision_id, asset_id) VALUES (?, ?)').run(id, assetId);
      linkedAssetIds.add(assetId);
    }
    database.prepare('UPDATE channels SET current_revision_id = ? WHERE id = ?').run(id, channelId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    id,
    channel: channelId,
    profileVersion: input.profileVersion,
    html: input.html,
    assetIds: input.assetIds,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolValidationError('invalid_protocol_value', 'body', 'body must be an object');
  }
  return value as Record<string, unknown>;
}

function isAuthorized(request: IncomingMessage, bearerToken: string): boolean {
  return request.headers.authorization === `Bearer ${bearerToken}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let content = '';
  for await (const chunk of request) {
    content += chunk;
    if (Buffer.byteLength(content) > MAX_REQUEST_BYTES) {
      throw new ProtocolValidationError('invalid_protocol_value', 'body', 'body exceeds the 1 MiB limit');
    }
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new ProtocolValidationError('invalid_protocol_value', 'body', 'body must be valid JSON');
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { protocolVersion: PROTOCOL_VERSION, code, message });
}
