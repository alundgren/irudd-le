import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  PROTOCOL_VERSION,
  channelSchema,
  revisionSchema,
  type Channel,
  type ProtocolError,
  type Revision,
} from '@irudd-le/protocol';
import { Store } from './store';

export interface MailboxOptions {
  databasePath: string;
  bearerTokens: string[];
  listen: { host: string; port: number };
  maxBodyBytes?: number;
}

export interface Mailbox {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
}

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export function createMailbox(options: MailboxOptions): Mailbox {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  let server: Server | undefined;
  let boundUrl = '';
  let store: Store | undefined;
  let ready = false;

  const start = async (): Promise<void> => {
    store = new Store(options.databasePath);
    ready = true;
    const http = await import('node:http');
    server = http.createServer((req, res) => {
      void handle(req, res, options, () => store!, maxBodyBytes, () => ready);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(options.listen.port, options.listen.host, () => {
        server!.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : options.listen.port;
    boundUrl = `http://${options.listen.host}:${port}`;
  };

  const stop = async (): Promise<void> => {
    ready = false;
    const s = server;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    server = undefined;
    store?.close();
    store = undefined;
  };

  return {
    start,
    stop,
    get url() {
      if (!server) throw new Error('Mailbox is not started');
      return boundUrl;
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: MailboxOptions,
  store: () => Store,
  maxBodyBytes: number,
  isReady: () => boolean
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '', 'http://mailbox.local');
  if (url.pathname === '/healthz' || url.pathname === '/readyz') {
    if (url.pathname === '/readyz' && !isReady()) {
      return sendError(res, 503, 'not_ready', 'Mailbox is not ready');
    }
    return sendJson(res, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
  }
  if (url.pathname.startsWith('/v1/')) {
    if (!isAuthorized(req, options.bearerTokens)) {
      return sendError(res, 401, 'unauthorized', 'A valid bearer token is required');
    }
    return routeV1(req, res, method, url.pathname, store, maxBodyBytes);
  }
  return sendError(res, 404, 'not_found', 'Not found');
}

async function routeV1(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  store: () => Store,
  maxBodyBytes: number
): Promise<void> {
  if (pathname === '/v1/channels' && method === 'POST') {
    return createChannel(req, res, store(), maxBodyBytes);
  }
  const channelMatch = pathname.match(/^\/v1\/channels\/([^/]+)$/);
  if (channelMatch) {
    const id = decodeURIComponent(channelMatch[1] ?? '');
    if (method === 'GET') return fetchChannel(res, store(), id);
  }
  const currentMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/revisions\/current$/);
  if (currentMatch) {
    const channelId = decodeURIComponent(currentMatch[1] ?? '');
    if (method === 'PUT') return publishRevision(req, res, store(), channelId, maxBodyBytes);
    if (method === 'GET') return getCurrentRevision(res, store(), channelId);
  }
  return sendError(res, 404, 'not_found', 'Not found');
}

async function createChannel(req: IncomingMessage, res: ServerResponse, store: Store, maxBodyBytes: number): Promise<void> {
  const result = await readJsonBody(req, maxBodyBytes);
  if (result.error) {
    return sendError(res, result.error.status, result.error.code, result.error.message);
  }
  const parsed = channelSchema.safeParse(result.value);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.code, parsed.error.message);
  }
  const channel: Channel = parsed.data;
  if (store.getChannel(channel.id)) {
    return sendError(res, 409, 'channel_exists', `Channel '${channel.id}' already exists`);
  }
  store.createChannel(channel);
  return sendJson(res, 201, channel);
}

function fetchChannel(res: ServerResponse, store: Store, id: string): void {
  const channel = store.getChannel(id);
  if (!channel) return sendError(res, 404, 'channel_not_found', `Channel '${id}' not found`);
  return sendJson(res, 200, channel);
}

async function publishRevision(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  channelId: string,
  maxBodyBytes: number
): Promise<void> {
  const result = await readJsonBody(req, maxBodyBytes);
  if (result.error) {
    return sendError(res, result.error.status, result.error.code, result.error.message);
  }
  const parsed = revisionSchema.safeParse(result.value);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.code, parsed.error.message);
  }
  const revision: Revision = parsed.data;
  if (revision.channel !== channelId) {
    return sendError(
      res,
      400,
      'channel_mismatch',
      `Revision channel '${revision.channel}' does not match URL '/v1/channels/${channelId}/revisions/current'`
    );
  }
  if (!store.getChannel(channelId)) {
    return sendError(res, 404, 'channel_not_found', `Channel '${channelId}' not found`);
  }
  try {
    store.publishRevision(channelId, revision);
  } catch (e) {
    if (isPrimaryKeyConflict(e)) {
      return sendError(
        res,
        409,
        'revision_conflict',
        `Revision '${revision.id}' already exists for channel '${channelId}`
      );
    }
    throw e;
  }
  return sendJson(res, 201, revision);
}

function getCurrentRevision(res: ServerResponse, store: Store, channelId: string): void {
  if (!store.getChannel(channelId)) {
    return sendError(res, 404, 'channel_not_found', `Channel '${channelId}' not found`);
  }
  const revision = store.getCurrentRevision(channelId);
  if (!revision) {
    return sendError(res, 404, 'no_current_revision', `Channel '${channelId}' has no current revision`);
  }
  return sendJson(res, 200, revision);
}

function isPrimaryKeyConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // `node:sqlite` exposes the SQLite extended result code on `.errcode`
  // (1555 = SQLITE_CONSTRAINT_PRIMARYKEY) even though the public TypeScript
  // types only declare `.code`. Fall back to the message string for forward
  // compatibility with renamed fields.
  const errcode = (error as { errcode?: unknown }).errcode;
  return errcode === 1555 || /UNIQUE constraint failed: revisions/.test(error.message);
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<{ error: ReadError } | { error: null; value: unknown }> {
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBodyBytes) {
      return { error: { status: 413, code: 'body_too_large', message: 'Request body exceeds the configured maximum' } };
    }
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBodyBytes) {
      return { error: { status: 413, code: 'body_too_large', message: 'Request body exceeds the configured maximum' } };
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return { error: null, value: {} };
  try {
    return { error: null, value: JSON.parse(text) as unknown };
  } catch {
    return { error: { status: 400, code: 'invalid_body', message: 'Request body is not valid JSON' } };
  }
}

interface ReadError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

function isAuthorized(req: IncomingMessage, tokens: string[]): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  return tokens.some((known) => timingSafeEqual(token, known));
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    const x = ab[i] ?? 0;
    const y = bb[i] ?? 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const error: ProtocolError = { protocolVersion: PROTOCOL_VERSION, code, message };
  sendJson(res, status, error);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length });
  res.end(payload);
}