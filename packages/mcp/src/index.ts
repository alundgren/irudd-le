import { createServer, type Server } from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  assetSchema,
  channelListSchema,
  channelSchema,
  createTokenRequestSchema,
  createdTokenSchema,
  pairTargetRequestSchema,
  protocolErrorSchema,
  pendingTargetListSchema,
  renderStatusObservationSchema,
  revisionDetailSchema,
  revisionListSchema,
  revisionPublicationSchema,
  rollbackRequestSchema,
  targetStatusSchema,
  targetProfileSchema,
  tokenListSchema,
} from '@irudd-le/protocol';
import { z } from 'zod';

export const MAX_ASSET_BYTES = 1024 * 1024;

export interface McpServiceOptions {
  mailboxUrl: string;
  /** Used exclusively as the mailbox's Authorization bearer credential. */
  mailboxAdminToken: string;
  listen: { host: string; port: number };
  fetch?: typeof globalThis.fetch;
}

export interface McpService {
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

class MailboxApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'MailboxApiError';
  }
}

class MailboxClient {
  private readonly baseUrl: URL;
  private readonly requestFetch: typeof globalThis.fetch;

  constructor(mailboxUrl: string, private readonly adminToken: string, requestFetch: typeof globalThis.fetch = globalThis.fetch) {
    this.baseUrl = new URL(mailboxUrl);
    this.requestFetch = requestFetch;
  }

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.requestFetch(new URL(path, this.baseUrl), {
        ...init,
        headers: { authorization: `Bearer ${this.adminToken}`, ...init.headers },
      });
    } catch {
      throw new MailboxApiError(502, 'transport_failure', 'The mailbox could not be reached');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new MailboxApiError(502, 'transport_failure', 'The mailbox response could not be read');
    }
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        if (!response.ok) throw new MailboxApiError(response.status, 'mailbox_failure', `The mailbox returned HTTP ${response.status}`);
        throw new MailboxApiError(502, 'invalid_mailbox_response', 'The mailbox returned an invalid response');
      }
    }
    if (!response.ok) {
      const error = protocolErrorSchema.safeParse(body);
      if (error.success) throw new MailboxApiError(response.status, error.data.code, this.redact(error.data.message));
      throw new MailboxApiError(response.status, 'mailbox_failure', `The mailbox returned HTTP ${response.status}`);
    }
    return body;
  }

  redact(value: string): string {
    return value.split(this.adminToken).join('[redacted]');
  }
}

function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, redact)]));
  }
  return value;
}

function jsonResult(value: unknown, redact: (text: string) => string): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown } {
  const safe = redactValue(value, redact);
  return { content: [{ type: 'text', text: JSON.stringify(safe) }], structuredContent: safe };
}

function toolError(error: unknown, redact: (text: string) => string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (error instanceof MailboxApiError) {
    return { content: [{ type: 'text', text: redact(`Mailbox ${error.code}: ${error.message}`) }], isError: true };
  }
  if (error instanceof ProtocolValidationError) {
    return { content: [{ type: 'text', text: redact(`Invalid input: ${error.message}`) }], isError: true };
  }
  return { content: [{ type: 'text', text: 'The MCP service could not complete this operation' }], isError: true };
}

async function runTool(client: MailboxClient, operation: () => Promise<unknown>): Promise<ReturnType<typeof jsonResult> | ReturnType<typeof toolError>> {
  try {
    return jsonResult(await operation(), (value) => client.redact(value));
  } catch (error: unknown) {
    return toolError(error, (value) => client.redact(value));
  }
}

function decodeAsset(contentType: 'image/png' | 'image/webp', source: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source)) {
    throw new ProtocolValidationError('invalid_protocol_value', 'uploadAsset.dataBase64', 'uploadAsset.dataBase64 must be valid padded base64');
  }
  const bytes = Buffer.from(source, 'base64');
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new ProtocolValidationError('invalid_protocol_value', 'uploadAsset.dataBase64', `uploadAsset.dataBase64 must decode to at most ${MAX_ASSET_BYTES} bytes`);
  }
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'));
  if (!isPng && !isWebp) {
    throw new ProtocolValidationError('invalid_protocol_value', 'uploadAsset.dataBase64', 'uploadAsset.dataBase64 must contain PNG or WebP bytes');
  }
  if ((contentType === 'image/png') !== isPng) {
    throw new ProtocolValidationError('invalid_protocol_value', 'uploadAsset.contentType', 'uploadAsset.contentType must match the decoded bytes');
  }
  return bytes;
}

function createMcpServer(client: MailboxClient): McpServer {
  const server = new McpServer({ name: 'irudd-le-mailbox', version: '0.1.0' });
  const channelId = z.string().min(1);
  const revisionInput = z.object({
    id: z.string().min(1), channel: channelId, profileVersion: z.number().int().positive(), html: z.string().min(1), assetIds: z.array(z.string()),
    title: z.string().min(1), description: z.string().nullable().optional(), expectedCurrentRevisionId: z.string().min(1).nullable().optional(),
  });

  server.registerTool('list_channels', {
    description: 'List every mailbox channel. Read the channel and target details before composing a revision.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true },
  }, () => runTool(client, async () => channelListSchema.parse(await client.request('/v1/channels'))));

  server.registerTool('get_channel', { description: 'Get one channel by id.', inputSchema: z.object({ channelId }), annotations: { readOnlyHint: true } },
    ({ channelId: id }) => runTool(client, async () => channelSchema.parse(await client.request(`/v1/channels/${encodeURIComponent(id)}`))));
  server.registerTool('get_channel_profile', { description: 'Get the live target profile for a channel.', inputSchema: z.object({ channelId }), annotations: { readOnlyHint: true } },
    ({ channelId: id }) => runTool(client, async () => targetProfileSchema.parse(await client.request(`/v1/channels/${encodeURIComponent(id)}/profile`))));
  server.registerTool('get_channel_target', { description: 'Get the target assigned to a channel.', inputSchema: z.object({ channelId }), annotations: { readOnlyHint: true } },
    ({ channelId: id }) => runTool(client, async () => targetStatusSchema.parse(await client.request(`/v1/channels/${encodeURIComponent(id)}/target`))));
  server.registerTool('get_render_status', { description: 'Get the latest render status for a channel.', inputSchema: z.object({ channelId }), annotations: { readOnlyHint: true } },
    ({ channelId: id }) => runTool(client, async () => renderStatusObservationSchema.parse(await client.request(`/v1/channels/${encodeURIComponent(id)}/render-status`))));
  server.registerTool('get_current_revision', { description: 'Get a channel’s current revision.', inputSchema: z.object({ channelId }), annotations: { readOnlyHint: true } },
    ({ channelId: id }) => runTool(client, async () => revisionPublicationSchema.parse(await client.request(`/v1/channels/${encodeURIComponent(id)}/revisions/current`))));
  server.registerTool('list_revisions', { description: 'List a channel’s retained revision history.', inputSchema: z.object({ channelId }), annotations: { readOnlyHint: true } },
    ({ channelId: id }) => runTool(client, async () => revisionListSchema.parse(await client.request(`/v1/channels/${encodeURIComponent(id)}/revisions`))));
  server.registerTool('get_revision', { description: 'Get one retained revision.', inputSchema: z.object({ channelId, revisionId: z.string().min(1) }), annotations: { readOnlyHint: true } },
    ({ channelId: id, revisionId }) => runTool(client, async () => revisionDetailSchema.parse(await client.request(`/v1/channels/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`))));
  server.registerTool('list_credentials', { description: 'List mailbox credentials without their secrets.', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    () => runTool(client, async () => tokenListSchema.parse(await client.request('/v1/admin/tokens'))));
  server.registerTool('list_pending_targets', { description: 'List pending overlay targets available for pairing.', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    () => runTool(client, async () => pendingTargetListSchema.parse(await client.request('/v1/admin/targets'))));

  server.registerTool('preview_revision', {
    description: 'Validate and return the complete draft revision before publishing. Use this by default; skip it only when the user explicitly asks to compose and publish.',
    inputSchema: revisionInput, annotations: { readOnlyHint: true },
  }, (input) => runTool(client, async () => revisionPublicationSchema.parse({ protocolVersion: PROTOCOL_VERSION, ...input })));
  server.registerTool('create_channel', { description: 'Create a named channel.', inputSchema: z.object({ id: channelId, name: z.string().min(1) }), annotations: { destructiveHint: false } },
    (input) => runTool(client, async () => {
      const channel = channelSchema.parse({ protocolVersion: PROTOCOL_VERSION, ...input });
      return channelSchema.parse(await client.request('/v1/channels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(channel) }));
    }));
  server.registerTool('publish_revision', {
    description: 'Publish a complete, validated revision. Preview first unless the user explicitly asked to compose and publish.', inputSchema: revisionInput, annotations: { destructiveHint: false },
  }, (input) => runTool(client, async () => {
    const revision = revisionPublicationSchema.parse({ protocolVersion: PROTOCOL_VERSION, ...input });
    return revisionPublicationSchema.parse(await client.request(`/v1/channels/${encodeURIComponent(revision.channel)}/revisions/current`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(revision) }));
  }));
  server.registerTool('upload_asset', {
    description: 'Upload final PNG or WebP bytes only. Do not send source-image batches or request conversion.',
    inputSchema: z.object({ channelId, contentType: z.enum(['image/png', 'image/webp']), dataBase64: z.string().min(1) }), annotations: { destructiveHint: false },
  }, ({ channelId: id, contentType, dataBase64 }) => runTool(client, async () => {
    const bytes = decodeAsset(contentType, dataBase64);
    return assetSchema.parse(await client.request(`/v1/channels/${encodeURIComponent(id)}/assets`, { method: 'POST', headers: { 'content-type': contentType }, body: new Blob([new Uint8Array(bytes).buffer]) }));
  }));
  server.registerTool('create_credential', { description: 'Create a mailbox credential. Its generated secret is returned exactly once.', inputSchema: z.object({ kind: z.enum(['admin', 'publisher', 'reader']), channel: channelId.nullable().optional(), label: z.string().min(1) }), annotations: { destructiveHint: false } },
    (input) => runTool(client, async () => {
      const request = createTokenRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, ...input });
      return createdTokenSchema.parse(await client.request('/v1/admin/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }));
    }));

  server.registerTool('pair_target', { description: 'Pair a pending target to a new channel. Set confirm: true only after the user confirms this destructive operation.', inputSchema: z.object({ targetId: z.string().min(1), pairingCode: z.string().min(1), channelId, channelName: z.string().min(1), confirm: z.boolean().optional() }), annotations: { destructiveHint: true } },
    ({ targetId, pairingCode, channelId: id, channelName, confirm }) => runTool(client, async () => {
      if (confirm !== true) return { confirmationRequired: true, operation: 'pair_target', summary: `Pair target '${targetId}' with new channel '${id}'.` };
      const body = createPairRequest(pairingCode, id, channelName);
      return channelSchema.parse(await client.request(`/v1/admin/targets/${encodeURIComponent(targetId)}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    }));
  server.registerTool('rollback_revision', { description: 'Roll back a channel by creating a new current revision from a retained revision. Set confirm: true only after user confirmation.', inputSchema: z.object({ channelId, sourceRevisionId: z.string().min(1), newRevisionId: z.string().min(1), expectedCurrentRevisionId: z.string().min(1).nullable().optional(), confirm: z.boolean().optional() }), annotations: { destructiveHint: true } },
    ({ channelId: id, sourceRevisionId, newRevisionId, expectedCurrentRevisionId, confirm }) => runTool(client, async () => {
      if (confirm !== true) return { confirmationRequired: true, operation: 'rollback_revision', summary: `Create revision '${newRevisionId}' by rolling channel '${id}' back to '${sourceRevisionId}'.` };
      const body = rollbackRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, newRevisionId, expectedCurrentRevisionId });
      return revisionDetailSchema.parse(await client.request(`/v1/channels/${encodeURIComponent(id)}/revisions/${encodeURIComponent(sourceRevisionId)}/rollback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    }));
  server.registerTool('revoke_credential', { description: 'Revoke a mailbox credential. Set confirm: true only after user confirmation.', inputSchema: z.object({ credentialId: z.string().min(1), confirm: z.boolean().optional() }), annotations: { destructiveHint: true } },
    ({ credentialId, confirm }) => runTool(client, async () => {
      if (confirm !== true) return { confirmationRequired: true, operation: 'revoke_credential', summary: `Revoke credential '${credentialId}'.` };
      await client.request(`/v1/admin/tokens/${encodeURIComponent(credentialId)}`, { method: 'DELETE' });
      return { revokedCredentialId: credentialId };
    }));
  return server;
}

function createPairRequest(pairingCode: string, channelId: string, channelName: string): unknown {
  return pairTargetRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, pairingCode, channelId, channelName });
}

export function createMcpService(options: McpServiceOptions): McpService {
  const client = new MailboxClient(options.mailboxUrl, options.mailboxAdminToken, options.fetch);
  const handler = createMcpHandler(() => createMcpServer(client), { legacy: 'stateless' });
  const mcpHandler = toNodeHandler(handler);
  let httpServer: Server | undefined;
  let boundUrl = '';
  return {
    get url(): string { return boundUrl; },
    async start(): Promise<void> {
      if (httpServer) throw new Error('MCP service is already running');
      httpServer = createServer((req, res) => {
        if (req.headers.origin !== undefined) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'origin_not_allowed' }));
          return;
        }
        const path = new URL(req.url ?? '/', 'http://mcp.local').pathname;
        if (path === '/healthz' || path === '/readyz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (path !== '/mcp') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        void mcpHandler(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal_error' }));
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        const server = httpServer!;
        server.once('error', reject);
        server.listen(options.listen.port, options.listen.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('MCP service did not bind a TCP port');
      boundUrl = `http://${options.listen.host}:${address.port}`;
    },
    async stop(): Promise<void> {
      await handler.close();
      const server = httpServer;
      httpServer = undefined;
      boundUrl = '';
      if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

export function createMcpServiceFromEnvironment(env: NodeJS.ProcessEnv = process.env): McpService {
  const mailboxUrl = env.MCP_MAILBOX_URL;
  const mailboxAdminToken = env.MCP_MAILBOX_ADMIN_TOKEN;
  if (!mailboxUrl || !mailboxAdminToken) throw new Error('MCP_MAILBOX_URL and MCP_MAILBOX_ADMIN_TOKEN are required');
  const port = env.MCP_LISTEN_PORT === undefined ? 8081 : Number(env.MCP_LISTEN_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP_LISTEN_PORT must be a TCP port number');
  return createMcpService({ mailboxUrl, mailboxAdminToken, listen: { host: env.MCP_LISTEN_HOST || '0.0.0.0', port } });
}

if (require.main === module) {
  void createMcpServiceFromEnvironment().start().catch(() => { process.exitCode = 1; });
}

export { channelListSchema, channelSchema, protocolErrorSchema } from '@irudd-le/protocol';
