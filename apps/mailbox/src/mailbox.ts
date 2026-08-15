import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  PROTOCOL_VERSION,
  channelSchema,
  createTokenRequestSchema,
  heartbeatRequestSchema,
  pairTargetRequestSchema,
  registerTargetRequestSchema,
  revisionPublicationSchema,
  type Channel,
  type CreatedToken,
  type HeartbeatResponse,
  type PendingTarget,
  type ProtocolError,
  type Revision,
  type TargetRegistration,
  type TokenKind,
  type TokenSummary,
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
      return publishRevision(req, res, store, channelId, maxBodyBytes, revisionEvents);
    }
    if (method === 'GET') {
      if (!canAccessChannel(principal, channelId, ['publisher', 'reader', 'target'])) return forbidden(res);
      return getCurrentRevision(res, store, channelId);
    }
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
  try {
    const result = store.publishRevision(channelId, revision, expectedCurrentRevisionId);
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
  store.touchTargetHeartbeat(principal.id, parsed.data.profile);
  const response: HeartbeatResponse = { protocolVersion: PROTOCOL_VERSION, targetId: principal.id, channel: principal.channel };
  return sendJson(res, 200, response);
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
