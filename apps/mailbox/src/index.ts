import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  channelSchema,
  protocolErrorSchema,
  protocolVersionSchema,
  revisionSchema,
  targetProfileSchema,
  type Channel,
  type Revision,
} from '@irudd-le/protocol';

const MAX_JSON_BYTES = 1_048_576;
const channelName = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface MailboxOptions {
  databasePath: string;
  bearerToken: string;
  host?: string;
  port?: number;
}

export interface MailboxServer {
  readonly url: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface ChannelRow { id: string; name: string; current_revision_id: string | null; }
interface RevisionRow { id: string; channel_id: string; profile_version: number; html: Uint8Array; }
interface AssetInput { id: string; contentType: string; data: string; sha256: string; }

/** Starts the canonical, versioned HTTP boundary for a durable mailbox. */
export async function createMailboxServer(options: MailboxOptions): Promise<MailboxServer> {
  if (!options.bearerToken) throw new Error('bearerToken must not be empty');

  const database = new DatabaseSync(options.databasePath, { enableForeignKeyConstraints: true, timeout: 5_000 });
  migrate(database);

  const server = createServer((request, response) => {
    void handleRequest(database, options.bearerToken, request, response).catch((error: unknown) => {
      if (error instanceof RequestError) return sendError(response, error.status, error.code, error.message);
      if (error instanceof ProtocolValidationError) return sendError(response, 400, error.code, error.message);
      console.error('Unhandled mailbox request error', error);
      sendError(response, 500, 'internal_error', 'The mailbox could not process the request.');
    });
  });
  let url = '';

  return {
    get url() { return url; },
    async listen() {
      if (server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
          server.off('error', reject);
          const address = server.address();
          if (!address || typeof address === 'string') return reject(new Error('Mailbox did not receive a TCP address'));
          url = `http://${address.address}:${address.port}`;
          resolve();
        });
      });
    },
    async close() {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      database.close();
    },
  };
}

function migrate(database: DatabaseSync): void {
  database.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
    `);
    const migration = database.prepare('SELECT version FROM schema_migrations WHERE version = ?');
    if (!migration.get(2)) {
      database.exec(`
        ALTER TABLE channels ADD COLUMN current_revision_id TEXT REFERENCES revisions(id);
        CREATE TABLE revisions (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id),
          profile_version INTEGER NOT NULL,
          html BLOB NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) STRICT;
        CREATE TABLE assets (
          id TEXT PRIMARY KEY,
          content_type TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          content BLOB NOT NULL
        ) STRICT;
        CREATE TABLE revision_assets (
          revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL REFERENCES assets(id),
          PRIMARY KEY (revision_id, asset_id)
        ) STRICT;
        CREATE TABLE targets (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id),
          profile_json TEXT NOT NULL,
          registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) STRICT;
        INSERT INTO schema_migrations (version) VALUES (2);
      `);
    }
    database.exec('COMMIT');
  } catch (error: unknown) {
    database.exec('ROLLBACK');
    throw error;
  }
}

async function handleRequest(database: DatabaseSync, bearerToken: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? 'GET';
  const pathname = new URL(request.url ?? '/', 'http://mailbox.local').pathname;

  if (method === 'GET' && pathname === '/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (method === 'GET' && pathname === '/ready') {
    sendJson(response, 200, { status: 'ready' });
    return;
  }
  if (!pathname.startsWith('/v1/')) {
    sendError(response, 404, 'not_found', 'No endpoint matches this request.');
    return;
  }
  if (request.headers.authorization !== `Bearer ${bearerToken}`) {
    sendError(response, 401, 'invalid_credentials', 'A valid bearer token is required.');
    return;
  }

  if (method === 'POST' && pathname === '/v1/channels') {
    const body = await readJson(request);
    validateProtocolVersion(body);
    const name = valueString(body.name, 'name');
    if (!channelName.test(name)) throw invalid('name', 'must be a lowercase channel slug of up to 64 characters');
    try {
      database.prepare('INSERT INTO channels (id, name) VALUES (?, ?)').run(name, name);
    } catch (error: unknown) {
      if (isConstraintError(error)) return sendError(response, 409, 'channel_exists', `Channel '${name}' already exists.`);
      throw error;
    }
    sendJson(response, 201, channel(name, name));
    return;
  }

  const channelMatch = /^\/v1\/channels\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && channelMatch) {
    const id = decodeURIComponent(channelMatch[1]!);
    const row = database.prepare('SELECT id, name, current_revision_id FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
    if (!row) return sendError(response, 404, 'channel_not_found', `Channel '${id}' does not exist.`);
    sendJson(response, 200, channel(row.id, row.name));
    return;
  }

  const revisionMatch = /^\/v1\/channels\/([^/]+)\/revisions$/.exec(pathname);
  if (method === 'POST' && revisionMatch) {
    const channelId = decodeURIComponent(revisionMatch[1]!);
    const body = await readJson(request);
    validateProtocolVersion(body);
    publishRevision(database, channelId, body);
    const published = getCurrentRevision(database, channelId);
    sendJson(response, 201, published);
    return;
  }

  const currentRevisionMatch = /^\/v1\/channels\/([^/]+)\/revisions\/current$/.exec(pathname);
  if (method === 'GET' && currentRevisionMatch) {
    const channelId = decodeURIComponent(currentRevisionMatch[1]!);
    const revision = getCurrentRevision(database, channelId);
    if (!revision) return sendError(response, 404, 'revision_not_found', `Channel '${channelId}' has no active revision.`);
    sendJson(response, 200, revision);
    return;
  }

  const historyMatch = /^\/v1\/channels\/([^/]+)\/revisions\/history$/.exec(pathname);
  if (method === 'GET' && historyMatch) {
    const channelId = decodeURIComponent(historyMatch[1]!);
    requireChannel(database, channelId);
    const history = database.prepare('SELECT id, profile_version FROM revisions WHERE channel_id = ? ORDER BY rowid DESC').all(channelId) as Array<{ id: string; profile_version: number }>;
    sendJson(response, 200, { protocolVersion: PROTOCOL_VERSION, channel: channelId, revisions: history.map((row) => ({ id: row.id, profileVersion: row.profile_version })) });
    return;
  }

  const targetMatch = /^\/v1\/channels\/([^/]+)\/targets$/.exec(pathname);
  if (method === 'POST' && targetMatch) {
    const channelId = decodeURIComponent(targetMatch[1]!);
    const body = await readJson(request);
    validateProtocolVersion(body);
    const id = valueString(body.id, 'id');
    const profile = targetProfileSchema.parse(body.profile);
    requireChannel(database, channelId);
    database.prepare(`INSERT INTO targets (id, channel_id, profile_json) VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET id = excluded.id, profile_json = excluded.profile_json, registered_at = CURRENT_TIMESTAMP`).run(id, channelId, JSON.stringify(profile));
    sendJson(response, 201, { protocolVersion: PROTOCOL_VERSION, id, channel: channelId, profile });
    return;
  }

  const assetMatch = /^\/v1\/assets\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && assetMatch) {
    const id = decodeURIComponent(assetMatch[1]!);
    const asset = database.prepare('SELECT content_type, content FROM assets WHERE id = ?').get(id) as { content_type: string; content: Uint8Array } | undefined;
    if (!asset) return sendError(response, 404, 'asset_not_found', `Asset '${id}' does not exist.`);
    response.writeHead(200, { 'content-type': asset.content_type, 'content-length': String(asset.content.byteLength), 'cache-control': 'public, immutable, max-age=31536000' });
    response.end(asset.content);
    return;
  }
  sendError(response, 404, 'not_found', 'No endpoint matches this request.');
}

function publishRevision(database: DatabaseSync, channelId: string, body: Record<string, unknown>): void {
  const id = valueString(body.id, 'id');
  const html = valueString(body.html, 'html');
  const profileVersion = positiveInteger(body.profileVersion, 'profileVersion');
  const assets = parseAssets(body.assets);
  requireChannel(database, channelId);

  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('INSERT INTO revisions (id, channel_id, profile_version, html) VALUES (?, ?, ?, ?)').run(id, channelId, profileVersion, Buffer.from(html));
    const insertAsset = database.prepare('INSERT INTO assets (id, content_type, byte_length, sha256, content) VALUES (?, ?, ?, ?, ?)');
    const existingAsset = database.prepare('SELECT content_type, sha256, content FROM assets WHERE id = ?');
    const linkAsset = database.prepare('INSERT INTO revision_assets (revision_id, asset_id) VALUES (?, ?)');
    for (const asset of assets) {
      const content = Buffer.from(asset.data, 'base64');
      const existing = existingAsset.get(asset.id) as { content_type: string; sha256: string; content: Uint8Array } | undefined;
      if (!existing) {
        insertAsset.run(asset.id, asset.contentType, content.byteLength, asset.sha256, content);
      } else if (existing.content_type !== asset.contentType || existing.sha256 !== asset.sha256 || !Buffer.from(existing.content).equals(content)) {
        throw new RequestError(409, 'asset_conflict', `Asset '${asset.id}' already exists with different content.`);
      }
      linkAsset.run(id, asset.id);
    }
    database.prepare('UPDATE channels SET current_revision_id = ? WHERE id = ?').run(id, channelId);
    database.exec('COMMIT');
  } catch (error: unknown) {
    database.exec('ROLLBACK');
    if (isConstraintError(error)) throw new RequestError(409, 'revision_conflict', 'Revision and asset identifiers are immutable and must be unique.');
    throw error;
  }
}

function getCurrentRevision(database: DatabaseSync, channelId: string): Revision | undefined {
  const row = database.prepare(`SELECT revisions.id, revisions.channel_id, revisions.profile_version, revisions.html
    FROM channels JOIN revisions ON revisions.id = channels.current_revision_id WHERE channels.id = ?`).get(channelId) as RevisionRow | undefined;
  if (!row) return undefined;
  const assetIds = database.prepare('SELECT asset_id FROM revision_assets WHERE revision_id = ? ORDER BY asset_id').all(row.id) as Array<{ asset_id: string }>;
  return revisionSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    id: row.id,
    channel: row.channel_id,
    profileVersion: row.profile_version,
    html: Buffer.from(row.html).toString('utf8'),
    assetIds: assetIds.map((asset) => asset.asset_id),
  });
}

function requireChannel(database: DatabaseSync, channelId: string): void {
  if (!database.prepare('SELECT 1 FROM channels WHERE id = ?').get(channelId)) {
    throw new RequestError(404, 'channel_not_found', `Channel '${channelId}' does not exist.`);
  }
}

function parseAssets(value: unknown): AssetInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid('assets', 'must be an array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid(`assets[${index}]`, 'must be an object');
    const input = item as Record<string, unknown>;
    const id = valueString(input.id, `assets[${index}].id`);
    const contentType = valueString(input.contentType, `assets[${index}].contentType`);
    const data = valueString(input.data, `assets[${index}].data`);
    const sha256 = valueString(input.sha256, `assets[${index}].sha256`);
    if (!/^[a-f0-9]{64}$/i.test(sha256)) throw invalid(`assets[${index}].sha256`, 'must be a SHA-256 digest');
    if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) throw invalid(`assets[${index}].data`, 'must be base64');
    if (createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex') !== sha256.toLowerCase()) {
      throw invalid(`assets[${index}].sha256`, 'must match the asset data');
    }
    return { id, contentType, data, sha256 };
  });
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw invalid(path, 'must be a positive integer');
  return value;
}

function channel(id: string, name: string): Channel {
  return channelSchema.parse({ protocolVersion: PROTOCOL_VERSION, id, name });
}

function validateProtocolVersion(body: Record<string, unknown>): void {
  protocolVersionSchema.parse(body.protocolVersion);
}

function valueString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(path, 'must be a non-empty string');
  return value;
}

function invalid(path: string, message: string): ProtocolValidationError {
  return new ProtocolValidationError('invalid_protocol_value', path, `${path} ${message}`);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > MAX_JSON_BYTES) throw new RequestError(413, 'payload_too_large', `JSON payloads may not exceed ${MAX_JSON_BYTES} bytes.`);
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('body', 'must be an object');
    return value as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new RequestError(400, 'invalid_json', 'The request body must be valid JSON.');
    throw error;
  }
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, protocolErrorSchema.parse({ protocolVersion: PROTOCOL_VERSION, code, message }));
}

if (require.main === module) {
  void createMailboxServer({
    databasePath: process.env.MAILBOX_DATABASE_PATH ?? '/var/lib/mailbox/mailbox.sqlite',
    bearerToken: process.env.MAILBOX_BEARER_TOKEN ?? '',
    host: process.env.MAILBOX_HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? '3000'),
  }).then((mailbox) => mailbox.listen());
}
