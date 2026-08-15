import {
  protocolErrorSchema,
  revisionSchema,
  targetProfileSchema,
  type Revision,
  type TargetProfile,
} from '@irudd-le/protocol';

export class RevisionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'RevisionApiError';
  }
}

export async function fetchCurrentRevision(
  mailboxUrl: string,
  channel: string,
  secret: string,
  signal?: AbortSignal
): Promise<Revision> {
  return request(
    mailboxUrl,
    `/v1/channels/${encodeURIComponent(channel)}/revisions/current`,
    secret,
    revisionSchema,
    signal
  );
}

export async function fetchChannelProfile(
  mailboxUrl: string,
  channel: string,
  secret: string,
  signal?: AbortSignal
): Promise<TargetProfile> {
  return request(mailboxUrl, `/v1/channels/${encodeURIComponent(channel)}/profile`, secret, targetProfileSchema, signal);
}

export async function openRevisionEvents(
  mailboxUrl: string,
  channel: string,
  secret: string,
  signal: AbortSignal
): Promise<Response> {
  const res = await fetch(new URL(`/v1/channels/${encodeURIComponent(channel)}/events`, mailboxUrl), {
    headers: { authorization: `Bearer ${secret}` },
    signal,
  });
  if (!res.ok) throw await apiError(res);
  if (!res.body) throw new RevisionApiError(res.status, 'stream_unavailable', 'The mailbox did not provide an event stream');
  return res;
}

async function request<T>(
  mailboxUrl: string,
  urlPath: string,
  secret: string,
  schema: { parse(value: unknown): T },
  signal?: AbortSignal
): Promise<T> {
  const res = await fetch(new URL(urlPath, mailboxUrl), {
    headers: { authorization: `Bearer ${secret}` },
    signal,
  });
  if (!res.ok) throw await apiError(res);
  return schema.parse(await res.json());
}

async function apiError(res: Response): Promise<RevisionApiError> {
  const parsed = protocolErrorSchema.safeParse(await res.json().catch(() => null));
  return parsed.success
    ? new RevisionApiError(res.status, parsed.data.code, parsed.data.message)
    : new RevisionApiError(res.status, 'request_failed', `HTTP ${res.status}`);
}
