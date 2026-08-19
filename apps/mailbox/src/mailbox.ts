import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  PROTOCOL_VERSION,
  channelSchema,
  channelListSchema,
  createTokenRequestSchema,
  heartbeatRequestSchema,
  pairTargetRequestSchema,
  renderStatusSchema,
  renderStatusObservationSchema,
  registerTargetRequestSchema,
  revisionPublicationSchema,
  rollbackRequestSchema,
  isAssetContentType,
  type Asset,
  type AssetContentType,
  type Channel,
  type CreatedToken,
  type HeartbeatResponse,
  type PendingTarget,
  type ProtocolError,
  type Revision,
  type TargetRegistration,
  type TokenKind,
  type TokenSummary,
  targetStatusSchema,
} from '@irudd-le/protocol';
import { Store, type TokenRecord } from './store';
import { ADMIN_UI_HTML } from './admin-ui';

export interface MailboxOptions {
  databasePath: string;
  /**
   * Seeds the first admin token the first time this database is ever opened.
   * Ignored once any admin token (revoked or not) exists, so a restart never
   * resurrects a credential the admin has since replaced or revoked.
   */
  adminBootstrapToken?: string;
  listen: { host: string; port: number };
  maxBodyBytes?: number;
  /** How long a freshly registered target's pairing code stays valid. */
  pairingCodeTtlMs?: number;
}

/**
 * `target` is not a `TokenKind` (the wire credential-kind enum in
 * `@irudd-le/protocol`): a target authenticates with its own opaque secret,
 * self-issued at registration rather than admin-minted, and its `channel`
 * moves from `null` to an assigned id exactly once (at pairing). It still
 * flows through the same `authenticate()`/`Principal` choke point as every
 * other credential kind -- see docs/adr/0005-target-enrollment-and-pairing.md.
 */
type PrincipalKind = TokenKind | 'target';

interface Principal {
  id: string;
  kind: PrincipalKind;
  channel: string | null;
}

export interface Mailbox {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
}

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const TARGET_ONLINE_WINDOW_MS = 60 * 1000;

export function createMailbox(options: MailboxOptions): Mailbox {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const pairingCodeTtlMs = options.pairingCodeTtlMs ?? DEFAULT_PAIRING_CODE_TTL_MS;
  let server: Server | undefined;
  let boundUrl = '';
  let store: Store | undefined;
  const revisionEvents = new RevisionEvents();

  const start = async (): Promise<void> => {
    // The store is opened before the listener exists, so every request the
    // handler sees is served by an open database.
    const openStore = new Store(options.databasePath);
    store = openStore;
    bootstrapAdminToken(openStore, options.adminBootstrapToken);
    const listener = createServer((req, res) => {
      handle(req, res, openStore, maxBodyBytes, pairingCodeTtlMs, revisionEvents).catch((error: unknown) => {
        console.error('Unhandled mailbox request error', error);
        if (!res.headersSent) {
          sendError(res, 500, 'internal_error', 'The mailbox could not process the request');
        }
        res.end();
      });
    });
    server = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(options.listen.port, options.listen.host, () => {
        listener.off('error', reject);
        resolve();
      });
    });
    const addr = listener.address();
    const port = addr && typeof addr === 'object' ? addr.port : options.listen.port;
    boundUrl = `http://${options.listen.host}:${port}`;
  };

  const stop = async (): Promise<void> => {
    const s = server;
    if (!s) return;
    revisionEvents.close();
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
  store: Store,
  maxBodyBytes: number,
  pairingCodeTtlMs: number,
  revisionEvents: RevisionEvents
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '', 'http://mailbox.local');
  if (url.pathname === '/healthz' || url.pathname === '/readyz') {
    return sendJson(res, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
  }
  if ((url.pathname === '/admin' || url.pathname === '/admin/') && method === 'GET') {
    return serveAdminUi(res);
  }
  // A brand-new overlay has no credential yet, so registration is the one
  // /v1/ write that precedes authentication -- see ADR-0005.
  if (url.pathname === '/v1/targets' && method === 'POST') {
    return registerTarget(req, res, store, maxBodyBytes, pairingCodeTtlMs);
  }
  if (url.pathname.startsWith('/v1/')) {
    const principal = authenticate(req, store);
    if (!principal) {
      return sendError(res, 401, 'unauthorized', 'A valid bearer token is required');
    }
    return routeV1(req, res, method, url.pathname, store, maxBodyBytes, principal, revisionEvents);
  }
  return sendError(res, 404, 'not_found', 'Not found');
}

async function routeV1(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  store: Store,
  maxBodyBytes: number,
  principal: Principal,
  revisionEvents: RevisionEvents
): Promise<void> {
  if (pathname === '/v1/channels' && method === 'GET') {
    if (principal.kind !== 'admin') return forbidden(res);
    return listChannels(res, store);
  }
  if (pathname === '/v1/channels' && method === 'POST') {
    if (principal.kind !== 'admin') return forbidden(res);
    return createChannel(req, res, store, maxBodyBytes);
  }
  const channelMatch = pathname.match(/^\/v1\/channels\/([^/]+)$/);
  if (channelMatch) {
    const id = decodeURIComponent(channelMatch[1] ?? '');
    if (method === 'GET') {
      if (!canAccessChannel(principal, id, ['publisher', 'reader'])) return forbidden(res);
      return fetchChannel(res, store, id);
    }
  }
  const currentMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/revisions\/current$/);
  if (currentMatch) {
    const channelId = decodeURIComponent(currentMatch[1] ?? '');
    if (method === 'PUT') {
      if (!canAccessChannel(principal, channelId, ['publisher'])) return forbidden(res);
      return publishRevision(req, res, store, channelId, maxBodyBytes, principal, revisionEvents);
    }
    if (method === 'GET') {
      if (!canAccessChannel(principal, channelId, ['publisher', 'reader', 'target'])) return forbidden(res);
      return getCurrentRevision(res, store, channelId);
    }
  }
  const revisionsListMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/revisions$/);
  if (revisionsListMatch && method === 'GET') {
    const channelId = decodeURIComponent(revisionsListMatch[1] ?? '');
    if (!canAccessChannel(principal, channelId, ['publisher', 'reader'])) return forbidden(res);
    return listRevisionsHandler(res, store, channelId);
  }
  const rollbackMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/revisions\/([^/]+)\/rollback$/);
  if (rollbackMatch && method === 'POST') {
    const channelId = decodeURIComponent(rollbackMatch[1] ?? '');
    const sourceRevisionId = decodeURIComponent(rollbackMatch[2] ?? '');
    if (!canAccessChannel(principal, channelId, ['publisher'])) return forbidden(res);
    return rollbackRevisionHandler(req, res, store, channelId, sourceRevisionId, maxBodyBytes, principal, revisionEvents);
  }
  // "current" is matched above and never reaches here, so a revision whose id
  // is literally "current" cannot be inspected by id -- an accepted, harmless
  // gap rather than a route collision to resolve.
  const revisionDetailMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/revisions\/([^/]+)$/);
  if (revisionDetailMatch && method === 'GET') {
    const channelId = decodeURIComponent(revisionDetailMatch[1] ?? '');
    const revisionId = decodeURIComponent(revisionDetailMatch[2] ?? '');
    if (!canAccessChannel(principal, channelId, ['publisher', 'reader'])) return forbidden(res);
    return getRevisionDetailHandler(res, store, channelId, revisionId);
  }
  const assetsMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/assets$/);
  if (assetsMatch && method === 'POST') {
    const channelId = decodeURIComponent(assetsMatch[1] ?? '');
    if (!canAccessChannel(principal, channelId, ['publisher'])) return forbidden(res);
    return uploadAsset(req, res, store, channelId, maxBodyBytes);
  }
  const assetMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/assets\/([^/]+)$/);
  if (assetMatch && method === 'GET') {
    const channelId = decodeURIComponent(assetMatch[1] ?? '');
    const assetId = decodeURIComponent(assetMatch[2] ?? '');
    if (!canAccessChannel(principal, channelId, ['publisher', 'reader', 'target'])) return forbidden(res);
    return getAssetHandler(res, store, channelId, assetId);
  }
  const eventsMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/events$/);
  if (eventsMatch && method === 'GET') {
    const channelId = decodeURIComponent(eventsMatch[1] ?? '');
    if (!canAccessChannel(principal, channelId, ['publisher', 'reader', 'target'])) return forbidden(res);
    if (!store.getChannel(channelId)) {
      return sendError(res, 404, 'channel_not_found', `Channel '${channelId}' not found`);
    }
    return revisionEvents.subscribe(channelId, res);
  }
  if (pathname === '/v1/admin/tokens') {
    if (principal.kind !== 'admin') return forbidden(res);
    if (method === 'POST') return createTokenHandler(req, res, store, maxBodyBytes);
    if (method === 'GET') return listTokensHandler(res, store);
  }
  const tokenMatch = pathname.match(/^\/v1\/admin\/tokens\/([^/]+)$/);
  if (tokenMatch) {
    if (principal.kind !== 'admin') return forbidden(res);
    const id = decodeURIComponent(tokenMatch[1] ?? '');
    if (method === 'DELETE') return revokeTokenHandler(res, store, id);
  }
  const profileMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/profile$/);
  if (profileMatch && method === 'GET') {
    const id = decodeURIComponent(profileMatch[1] ?? '');
    if (!canAccessChannel(principal, id, ['publisher', 'reader', 'target'])) return forbidden(res);
    return getChannelProfileHandler(res, store, id);
  }
  const heartbeatMatch = pathname.match(/^\/v1\/targets\/([^/]+)\/heartbeat$/);
  if (heartbeatMatch && method === 'PUT') {
    const id = decodeURIComponent(heartbeatMatch[1] ?? '');
    // Identity-bound, not scope-bound: a target may only heartbeat itself,
    // and (unlike channel routes) admin does not get a blanket bypass here
    // -- there is nothing for a superuser to usefully impersonate.
    if (principal.kind !== 'target' || principal.id !== id) return forbidden(res);
    return heartbeatTarget(req, res, store, maxBodyBytes, principal);
  }
  const renderStatusMatch = pathname.match(/^\/v1\/targets\/([^/]+)\/render-status$/);
  if (renderStatusMatch && method === 'PUT') {
    const id = decodeURIComponent(renderStatusMatch[1] ?? '');
    if (principal.kind !== 'target' || principal.id !== id) return forbidden(res);
    return reportRenderStatus(req, res, store, maxBodyBytes, id);
  }
  const targetMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/target$/);
  if (targetMatch && method === 'GET') {
    const channelId = decodeURIComponent(targetMatch[1] ?? '');
    if (!canAccessChannel(principal, channelId, ['publisher', 'reader', 'target'])) return forbidden(res);
    return getTargetHandler(res, store, channelId);
  }
  const renderStatusForChannelMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/render-status$/);
  if (renderStatusForChannelMatch && method === 'GET') {
    const channelId = decodeURIComponent(renderStatusForChannelMatch[1] ?? '');
    if (!canAccessChannel(principal, channelId, ['publisher', 'reader', 'target'])) return forbidden(res);
    return getRenderStatusHandler(res, store, channelId);
  }
  if (pathname === '/v1/admin/targets' && method === 'GET') {
    if (principal.kind !== 'admin') return forbidden(res);
    return listPendingTargetsHandler(res, store);
  }
  const pairMatch = pathname.match(/^\/v1\/admin\/targets\/([^/]+)\/pair$/);
  if (pairMatch && method === 'POST') {
    if (principal.kind !== 'admin') return forbidden(res);
    return pairTargetHandler(req, res, store, maxBodyBytes, decodeURIComponent(pairMatch[1] ?? ''));
  }
  return sendError(res, 404, 'not_found', 'Not found');
}

function listChannels(res: ServerResponse, store: Store): void {
  return sendJson(res, 200, channelListSchema.parse({ protocolVersion: PROTOCOL_VERSION, channels: store.listChannels() }));
}

function forbidden(res: ServerResponse): void {
  sendError(res, 403, 'forbidden', "The credential's scope does not permit this operation");
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
  maxBodyBytes: number,
  principal: Principal,
  revisionEvents: RevisionEvents
): Promise<void> {
  const result = await readJsonBody(req, maxBodyBytes);
  if (result.error) {
    return sendError(res, result.error.status, result.error.code, result.error.message);
  }
  const parsed = revisionPublicationSchema.safeParse(result.value);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.code, parsed.error.message);
  }
  const { expectedCurrentRevisionId, ...revision }: { expectedCurrentRevisionId?: string | null } & Revision = parsed.data;
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
  const profile = store.getChannelProfile(channelId);
  if (profile && revision.profileVersion !== profile.version) {
    return sendError(
      res,
      409,
      'profile_version_mismatch',
      `Revision profile version ${revision.profileVersion} does not match channel profile version ${profile.version}`
    );
  }
  const missingAssetIds = store.findMissingAssetIds(channelId, revision.assetIds);
  if (missingAssetIds.length > 0) {
    return sendError(
      res,
      400,
      'missing_asset_references',
      `Revision references asset id(s) not uploaded to channel '${channelId}': ${missingAssetIds.join(', ')}`
    );
  }
  try {
    const result = store.publishRevision(channelId, revision, principal.id, expectedCurrentRevisionId);
    if (result === 'current_revision_conflict') {
      return sendError(
        res,
        409,
        'current_revision_conflict',
        `Channel '${channelId}' no longer has the expected current revision`
      );
    }
  } catch (e) {
    if (isPrimaryKeyConflict(e)) {
      return sendError(
        res,
        409,
        'revision_conflict',
        `Revision '${revision.id}' already exists for channel '${channelId}'`
      );
    }
    throw e;
  }
  revisionEvents.publish(channelId, revision.id);
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

function listRevisionsHandler(res: ServerResponse, store: Store, channelId: string): void {
  if (!store.getChannel(channelId)) {
    return sendError(res, 404, 'channel_not_found', `Channel '${channelId}' not found`);
  }
  return sendJson(res, 200, { protocolVersion: PROTOCOL_VERSION, revisions: store.listRevisions(channelId) });
}

function getRevisionDetailHandler(res: ServerResponse, store: Store, channelId: string, revisionId: string): void {
  if (!store.getChannel(channelId)) {
    return sendError(res, 404, 'channel_not_found', `Channel '${channelId}' not found`);
  }
  const revision = store.getRevisionDetail(channelId, revisionId);
  if (!revision) {
    return sendError(res, 404, 'revision_not_found', `Revision '${revisionId}' not found for channel '${channelId}'`);
  }
  return sendJson(res, 200, revision);
}

async function rollbackRevisionHandler(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  channelId: string,
  sourceRevisionId: string,
  maxBodyBytes: number,
  principal: Principal,
  revisionEvents: RevisionEvents
): Promise<void> {
  const result = await readJsonBody(req, maxBodyBytes);
  if (result.error) {
    return sendError(res, result.error.status, result.error.code, result.error.message);
  }
  const parsed = rollbackRequestSchema.safeParse(result.value);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.code, parsed.error.message);
  }
  if (!store.getChannel(channelId)) {
    return sendError(res, 404, 'channel_not_found', `Channel '${channelId}' not found`);
  }
  const { newRevisionId, expectedCurrentRevisionId } = parsed.data;
  let outcome: 'rolled_back' | 'current_revision_conflict' | 'source_not_found';
  try {
    outcome = store.rollbackRevision(channelId, sourceRevisionId, newRevisionId, principal.id, expectedCurrentRevisionId);
  } catch (e) {
    if (isPrimaryKeyConflict(e)) {
      return sendError(
        res,
        409,
        'revision_conflict',
        `Revision '${newRevisionId}' already exists for channel '${channelId}'`
      );
    }
    throw e;
  }
  if (outcome === 'source_not_found') {
    return sendError(
      res,
      404,
      'revision_not_found',
      `Revision '${sourceRevisionId}' not found for channel '${channelId}'`
    );
  }
  if (outcome === 'current_revision_conflict') {
    return sendError(
      res,
      409,
      'current_revision_conflict',
      `Channel '${channelId}' no longer has the expected current revision`
    );
  }
  revisionEvents.publish(channelId, newRevisionId);
  const revision = store.getRevisionDetail(channelId, newRevisionId);
  return sendJson(res, 201, revision);
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

/**
 * In-memory connection registry only: the SQLite current-revision pointer is
 * the durable source of truth. A reconnecting overlay always fetches it, so a
 * missed event can never lose content.
 */
class RevisionEvents {
  private readonly subscribers = new Map<string, Set<ServerResponse>>();

  subscribe(channel: string, res: ServerResponse): void {
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.flushHeaders();
    const subscribers = this.subscribers.get(channel) ?? new Set<ServerResponse>();
    subscribers.add(res);
    this.subscribers.set(channel, subscribers);
    res.once('close', () => {
      subscribers.delete(res);
      if (subscribers.size === 0) this.subscribers.delete(channel);
    });
  }

  publish(channel: string, revisionId: string): void {
    const message = `event: revision\ndata: ${JSON.stringify({ revisionId })}\n\n`;
    for (const res of this.subscribers.get(channel) ?? []) {
      res.write(message);
    }
  }

  close(): void {
    for (const subscribers of this.subscribers.values()) {
      for (const res of subscribers) res.end();
    }
    this.subscribers.clear();
  }
}

/** Enforces maxBodyBytes against both the declared content-length and the actual stream, since a client can omit or lie about the former. */
async function readBoundedBody(req: IncomingMessage, maxBodyBytes: number): Promise<{ error: ReadError } | { error: null; value: Buffer }> {
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
  return { error: null, value: Buffer.concat(chunks) };
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<{ error: ReadError } | { error: null; value: unknown }> {
  const body = await readBoundedBody(req, maxBodyBytes);
  if (body.error) return body;
  const text = body.value.toString('utf8');
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

function authenticate(req: IncomingMessage, store: Store): Principal | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const secret = header.slice('Bearer '.length);
  if (secret.length === 0) return null;
  const hash = hashSecret(secret);
  const token = store.findActiveTokenByHash(hash);
  if (token) return { id: token.id, kind: token.kind, channel: token.channel };
  const target = store.findTargetBySecretHash(hash);
  if (target) return { id: target.id, kind: 'target', channel: target.channel };
  return null;
}

/**
 * An admin credential has full authority; publisher/reader/target credentials
 * are each bound to exactly one channel (target: only once paired) and only
 * within the kinds the caller allows for this operation (e.g. reading permits
 * both publisher and reader).
 */
function canAccessChannel(principal: Principal, channelId: string, allowed: PrincipalKind[]): boolean {
  if (principal.kind === 'admin') return true;
  return allowed.includes(principal.kind) && principal.channel === channelId;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

const TOKEN_SECRET_PREFIX: Record<TokenKind, string> = { admin: 'adm', publisher: 'pub', reader: 'rdr' };

function generateSecret(kind: TokenKind): string {
  return `${TOKEN_SECRET_PREFIX[kind]}_${randomBytes(24).toString('base64url')}`;
}

function generateTargetSecret(): string {
  return `tgt_${randomBytes(24).toString('base64url')}`;
}

/** Six digits, short enough to read off an overlay screen and type elsewhere. */
function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function bootstrapAdminToken(store: Store, adminBootstrapToken: string | undefined): void {
  if (store.hasAnyTokenOfKind('admin')) {
    if (adminBootstrapToken) {
      console.log('An admin token already exists; ignoring the supplied adminBootstrapToken/MAILBOX_ADMIN_BOOTSTRAP_TOKEN');
    }
    return;
  }
  if (!adminBootstrapToken) {
    throw new Error(
      'No admin token exists yet; set adminBootstrapToken (MAILBOX_ADMIN_BOOTSTRAP_TOKEN) to bootstrap one'
    );
  }
  store.createToken({
    id: randomUUID(),
    kind: 'admin',
    channel: null,
    label: 'bootstrap',
    secretHash: hashSecret(adminBootstrapToken),
    createdAt: Date.now(),
    revokedAt: null,
  });
}

function toTokenSummary(record: TokenRecord): TokenSummary {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: record.id,
    kind: record.kind,
    channel: record.channel,
    label: record.label,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

async function createTokenHandler(req: IncomingMessage, res: ServerResponse, store: Store, maxBodyBytes: number): Promise<void> {
  const result = await readJsonBody(req, maxBodyBytes);
  if (result.error) {
    return sendError(res, result.error.status, result.error.code, result.error.message);
  }
  const parsed = createTokenRequestSchema.safeParse(result.value);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.code, parsed.error.message);
  }
  const { kind, channel, label } = parsed.data;
  if (channel !== null && !store.getChannel(channel)) {
    return sendError(res, 404, 'channel_not_found', `Channel '${channel}' not found`);
  }
  const id = randomUUID();
  const secret = generateSecret(kind);
  const createdAt = Date.now();
  store.createToken({ id, kind, channel, label, secretHash: hashSecret(secret), createdAt, revokedAt: null });
  const created: CreatedToken = { ...toTokenSummary({ id, kind, channel, label, createdAt, revokedAt: null }), secret };
  return sendJson(res, 201, created, { 'cache-control': 'no-store' });
}

function listTokensHandler(res: ServerResponse, store: Store): void {
  return sendJson(res, 200, { tokens: store.listTokens().map(toTokenSummary) });
}

function revokeTokenHandler(res: ServerResponse, store: Store, id: string): void {
  const token = store.getToken(id);
  if (!token) {
    return sendError(res, 404, 'token_not_found', `Token '${id}' not found`);
  }
  // Revoking the last active admin would lock every /v1/admin/* route with
  // no restart-time recovery (bootstrap only ever seeds once per database),
  // so refuse the one revoke that would leave zero active admins.
  if (token.kind === 'admin' && token.revokedAt === null && store.countActiveTokensOfKind('admin') <= 1) {
    return sendError(res, 409, 'last_admin_token', 'Cannot revoke the last active admin token');
  }
  store.revokeToken(id);
  res.writeHead(204);
  res.end();
}

async function registerTarget(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  maxBodyBytes: number,
  pairingCodeTtlMs: number
): Promise<void> {
  const result = await readJsonBody(req, maxBodyBytes);
  if (result.error) {
    return sendError(res, result.error.status, result.error.code, result.error.message);
  }
  const parsed = registerTargetRequestSchema.safeParse(result.value);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.code, parsed.error.message);
  }
  const { clientName, profile } = parsed.data;
  const id = randomUUID();
  const secret = generateTargetSecret();
  const pairingCode = generatePairingCode();
  const now = Date.now();
  const pairingCodeExpiresAt = now + pairingCodeTtlMs;
  store.createTarget({
    id,
    secretHash: hashSecret(secret),
    clientName,
    profile,
    channel: null,
    pairingCode,
    pairingCodeExpiresAt,
    createdAt: now,
    lastSeenAt: now,
    capabilities: profile.features,
    clientVersion: 'unknown',
    profileChangedAt: null,
    republishRecommended: false,
  });
  const registration: TargetRegistration = { protocolVersion: PROTOCOL_VERSION, id, secret, pairingCode, pairingCodeExpiresAt };
  return sendJson(res, 201, registration, { 'cache-control': 'no-store' });
}

async function heartbeatTarget(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  maxBodyBytes: number,
  principal: Principal
): Promise<void> {
  const result = await readJsonBody(req, maxBodyBytes);
  if (result.error) {
    return sendError(res, result.error.status, result.error.code, result.error.message);
  }
  const parsed = heartbeatRequestSchema.safeParse(result.value);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.code, parsed.error.message);
  }
  const outcome = store.touchTargetHeartbeat(
    principal.id,
    parsed.data.profile,
    parsed.data.capabilities,
    parsed.data.clientVersion
  );
  const response: HeartbeatResponse = {
    protocolVersion: PROTOCOL_VERSION,
    targetId: principal.id,
    channel: principal.channel,
    profileVersion: outcome.profile.version,
    profileChanged: outcome.profileChanged,
    republishRecommended: outcome.republishRecommended,
  };
  return sendJson(res, 200, response);
}

async function reportRenderStatus(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  maxBodyBytes: number,
  targetId: string
): Promise<void> {
  const result = await readJsonBody(req, maxBodyBytes);
  if (result.error) return sendError(res, result.error.status, result.error.code, result.error.message);
  const parsed = renderStatusSchema.safeParse(result.value);
  if (!parsed.success) return sendError(res, 400, parsed.error.code, parsed.error.message);
  if (parsed.data.targetId !== targetId) return sendError(res, 403, 'forbidden', 'A target may only report its own render status');
  const outcome = store.recordRenderStatus(parsed.data);
  if (outcome === 'stale_profile') {
    return sendError(res, 409, 'stale_render_observation', 'The render observation does not match the target’s current profile');
  }
  if (outcome === 'stale_observation') {
    return sendError(res, 409, 'stale_render_observation', 'A newer render observation has already been recorded');
  }
  if (outcome === 'unknown_revision') {
    return sendError(res, 409, 'unknown_revision', 'The observation names a revision outside this target’s channel');
  }
  return sendJson(res, 200, { protocolVersion: PROTOCOL_VERSION });
}

function getTargetHandler(res: ServerResponse, store: Store, channelId: string): void {
  if (!store.getChannel(channelId)) return sendError(res, 404, 'channel_not_found', `Channel '${channelId}' not found`);
  const target = store.getTargetByChannel(channelId);
  if (!target) return sendError(res, 404, 'target_not_found', `Channel '${channelId}' has no target`);
  return sendJson(res, 200, targetStatusSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    id: target.id,
    channel: channelId,
    clientName: target.clientName,
    profile: target.profile,
    capabilities: target.capabilities,
    clientVersion: target.clientVersion,
    lastSeenAt: target.lastSeenAt,
    online: Date.now() - target.lastSeenAt <= TARGET_ONLINE_WINDOW_MS,
    profileChangedAt: target.profileChangedAt,
    republishRecommended: target.republishRecommended,
  }));
}

function getRenderStatusHandler(res: ServerResponse, store: Store, channelId: string): void {
  if (!store.getChannel(channelId)) return sendError(res, 404, 'channel_not_found', `Channel '${channelId}' not found`);
  const target = store.getTargetByChannel(channelId);
  if (!target) return sendError(res, 404, 'target_not_found', `Channel '${channelId}' has no target`);
  const status = store.getRenderStatus(target.id);
  if (!status) return sendError(res, 404, 'no_render_status', `Target '${target.id}' has not reported a render observation`);
  return sendJson(res, 200, renderStatusObservationSchema.parse({
    ...status,
    online: Date.now() - target.lastSeenAt <= TARGET_ONLINE_WINDOW_MS,
  }));
}

function listPendingTargetsHandler(res: ServerResponse, store: Store): void {
  const targets: PendingTarget[] = store.listPendingTargets().map((t) => ({
    protocolVersion: PROTOCOL_VERSION,
    id: t.id,
    clientName: t.clientName,
    profile: t.profile,
    pairingCodeExpiresAt: t.pairingCodeExpiresAt,
    createdAt: t.createdAt,
    lastSeenAt: t.lastSeenAt,
  }));
  return sendJson(res, 200, { targets });
}

async function pairTargetHandler(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  maxBodyBytes: number,
  targetId: string
): Promise<void> {
  const result = await readJsonBody(req, maxBodyBytes);
  if (result.error) {
    return sendError(res, result.error.status, result.error.code, result.error.message);
  }
  const parsed = pairTargetRequestSchema.safeParse(result.value);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.code, parsed.error.message);
  }
  const { pairingCode, channelId, channelName } = parsed.data;

  const target = store.getTarget(targetId);
  if (!target) {
    return sendError(res, 404, 'target_not_found', `Target '${targetId}' not found`);
  }
  if (target.channel !== null) {
    return sendError(res, 409, 'target_already_paired', `Target '${targetId}' is already paired; re-enroll it to retarget`);
  }
  if (target.pairingCode === null || target.pairingCodeExpiresAt === null || target.pairingCodeExpiresAt < Date.now()) {
    return sendError(res, 410, 'pairing_code_expired', 'The pairing code has expired; re-enroll the target');
  }
  if (target.pairingCode !== pairingCode) {
    return sendError(res, 400, 'invalid_pairing_code', 'The supplied pairing code does not match');
  }

  const channel: Channel = { protocolVersion: PROTOCOL_VERSION, id: channelId, name: channelName };
  const outcome = store.pairTarget(targetId, channel);
  if (outcome === 'target_not_found') {
    return sendError(res, 404, 'target_not_found', `Target '${targetId}' not found`);
  }
  if (outcome === 'target_already_paired') {
    return sendError(res, 409, 'target_already_paired', `Target '${targetId}' is already paired; re-enroll it to retarget`);
  }
  if (outcome === 'channel_exists') {
    return sendError(res, 409, 'channel_exists', `Channel '${channelId}' already exists`);
  }
  return sendJson(res, 201, channel);
}

function getChannelProfileHandler(res: ServerResponse, store: Store, channelId: string): void {
  if (!store.getChannel(channelId)) {
    return sendError(res, 404, 'channel_not_found', `Channel '${channelId}' not found`);
  }
  const profile = store.getChannelProfile(channelId);
  if (!profile) {
    return sendError(res, 404, 'no_profile', `Channel '${channelId}' has no target profile yet`);
  }
  return sendJson(res, 200, profile);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Signature-only detection (not a full parse) -- matches the issue's "validate actual PNG/WebP signatures" requirement without needing an image-decoding dependency. */
function detectAssetContentType(data: Buffer): AssetContentType | null {
  if (data.length >= PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

async function uploadAsset(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  channelId: string,
  maxBodyBytes: number
): Promise<void> {
  if (!store.getChannel(channelId)) {
    return sendError(res, 404, 'channel_not_found', `Channel '${channelId}' not found`);
  }
  const declaredContentType = req.headers['content-type'];
  if (!isAssetContentType(declaredContentType)) {
    return sendError(res, 400, 'unsupported_content_type', "The 'content-type' header must be 'image/png' or 'image/webp'");
  }
  const body = await readBoundedBody(req, maxBodyBytes);
  if (body.error) {
    return sendError(res, body.error.status, body.error.code, body.error.message);
  }
  const data = body.value;
  const actualContentType = detectAssetContentType(data);
  if (actualContentType === null) {
    return sendError(res, 400, 'invalid_asset_signature', 'The uploaded bytes are not a recognizable PNG or WebP image');
  }
  if (actualContentType !== declaredContentType) {
    return sendError(
      res,
      400,
      'asset_content_type_mismatch',
      `Declared content-type '${declaredContentType}' does not match the uploaded bytes (detected '${actualContentType}')`
    );
  }
  const sha256 = createHash('sha256').update(data).digest('hex');
  const outcome = store.createAssetForChannel(channelId, { id: sha256, contentType: actualContentType, byteLength: data.length, data });
  const asset: Asset = { protocolVersion: PROTOCOL_VERSION, id: sha256, contentType: actualContentType, byteLength: data.length, sha256 };
  return sendJson(res, outcome === 'granted' ? 201 : 200, asset);
}

function getAssetHandler(res: ServerResponse, store: Store, channelId: string, assetId: string): void {
  if (!store.getChannel(channelId)) {
    return sendError(res, 404, 'channel_not_found', `Channel '${channelId}' not found`);
  }
  const asset = store.getAssetForChannel(channelId, assetId);
  if (!asset) {
    return sendError(res, 404, 'asset_not_found', `Asset '${assetId}' not found`);
  }
  res.writeHead(200, {
    'content-type': asset.contentType,
    'content-length': asset.byteLength,
    // Assets are attacker-supplied bytes served from the mailbox's own origin.
    'x-content-type-options': 'nosniff',
  });
  res.end(Buffer.from(asset.data));
}

function serveAdminUi(res: ServerResponse): void {
  const payload = Buffer.from(ADMIN_UI_HTML, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const error: ProtocolError = { protocolVersion: PROTOCOL_VERSION, code, message };
  sendJson(res, status, error);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}
