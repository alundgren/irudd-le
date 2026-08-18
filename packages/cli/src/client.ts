import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  channelSchema,
  protocolErrorSchema,
  renderStatusObservationSchema,
  revisionSchema,
  targetProfileSchema,
  type Channel,
  type RenderStatusObservation,
  type Revision,
  type TargetProfile,
} from '@irudd-le/protocol';

export class MailboxApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'MailboxApiError';
  }
}

export type ChannelInspection =
  | { state: 'unbound'; channel: Channel }
  | { state: 'paired'; channel: Channel; profile: TargetProfile; renderStatus: RenderStatusObservation | null };

export interface PublicationInput {
  channel: string;
  title: string;
  description?: string;
  html: string;
  /** Defaults to the channel's current paired target profile version, or 1 when unbound. */
  profileVersion?: number;
}

export interface MailboxClientLike {
  inspectChannel(channelId: string): Promise<ChannelInspection>;
  publish(input: PublicationInput): Promise<Revision>;
}

type Fetcher = (input: URL, init?: RequestInit) => Promise<Response>;

/**
 * Thin SSH/CLI-facing client for the canonical mailbox API. It owns no
 * mailbox state or protocol types of its own, mirroring the shape of
 * apps/upload-ui's browser-facing UploadClient.
 */
export class MailboxClient implements MailboxClientLike {
  constructor(
    private readonly mailboxUrl: string,
    private readonly secret: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly createRevisionId: () => string = () => randomUUID()
  ) {}

  async inspectChannel(channelId: string): Promise<ChannelInspection> {
    this.assertChannelId(channelId);
    const channel = channelSchema.parse(await this.getJson(`/v1/channels/${encodeURIComponent(channelId)}`));
    const profile = await this.fetchProfile(channelId);
    if (!profile) return { state: 'unbound', channel };
    const renderStatus = await this.fetchRenderStatus(channelId);
    return { state: 'paired', channel, profile, renderStatus };
  }

  async publish(input: PublicationInput): Promise<Revision> {
    this.assertChannelId(input.channel);
    const profileVersion = input.profileVersion ?? (await this.currentProfileVersion(input.channel));
    const revision = revisionSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      id: this.createRevisionId(),
      channel: input.channel,
      profileVersion,
      title: input.title,
      description: input.description ?? null,
      html: input.html,
      assetIds: [],
    });
    const response = await this.fetcher(this.url(`/v1/channels/${encodeURIComponent(revision.channel)}/revisions/current`), {
      method: 'PUT',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(revision),
    });
    if (!response.ok) throw await apiError(response);
    return revisionSchema.parse(await response.json());
  }

  private async currentProfileVersion(channelId: string): Promise<number> {
    const profile = await this.fetchProfile(channelId);
    return profile?.version ?? 1;
  }

  /** Resolves to `null` for an unbound channel (the canonical `no_profile` response), not a thrown error. */
  private async fetchProfile(channelId: string): Promise<TargetProfile | null> {
    const response = await this.fetcher(this.url(`/v1/channels/${encodeURIComponent(channelId)}/profile`), { headers: this.authHeaders() });
    if (response.ok) return targetProfileSchema.parse(await response.json());
    const error = await apiError(response);
    if (error.status === 404 && error.code === 'no_profile') return null;
    throw error;
  }

  /** Resolves to `null` when the paired target has not reported a render observation yet, not a thrown error. */
  private async fetchRenderStatus(channelId: string): Promise<RenderStatusObservation | null> {
    const response = await this.fetcher(this.url(`/v1/channels/${encodeURIComponent(channelId)}/render-status`), { headers: this.authHeaders() });
    if (response.ok) return renderStatusObservationSchema.parse(await response.json());
    const error = await apiError(response);
    if (error.status === 404 && (error.code === 'no_render_status' || error.code === 'target_not_found')) return null;
    throw error;
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.fetcher(this.url(path), { headers: this.authHeaders() });
    if (!response.ok) throw await apiError(response);
    return response.json();
  }

  /** Validates the id shape against the shared protocol schema before spending a request on it. */
  private assertChannelId(channelId: string): void {
    channelSchema.parse({ protocolVersion: PROTOCOL_VERSION, id: channelId, name: 'placeholder' });
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.secret}` };
  }

  private url(path: string): URL {
    return new URL(path, this.mailboxUrl);
  }
}

async function apiError(response: Response): Promise<MailboxApiError> {
  const parsed = protocolErrorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? new MailboxApiError(response.status, parsed.data.code, parsed.data.message)
    : new MailboxApiError(response.status, 'request_failed', `HTTP ${response.status}`);
}
