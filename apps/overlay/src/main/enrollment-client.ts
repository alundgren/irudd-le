import {
  heartbeatResponseSchema,
  protocolErrorSchema,
  targetRegistrationSchema,
  type HeartbeatResponse,
  type RuntimeSchema,
  type TargetProfile,
  type TargetRegistration,
} from '@irudd-le/protocol';

/** Wraps a `protocolErrorSchema`-shaped mailbox error response. */
export class EnrollmentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'EnrollmentApiError';
  }
}

export async function registerTarget(
  mailboxUrl: string,
  clientName: string,
  profile: TargetProfile
): Promise<TargetRegistration> {
  return request(mailboxUrl, '/v1/targets', 'POST', undefined, { clientName, profile }, targetRegistrationSchema);
}

export async function heartbeat(
  mailboxUrl: string,
  targetId: string,
  secret: string,
  profile: TargetProfile
): Promise<HeartbeatResponse> {
  return request(
    mailboxUrl,
    `/v1/targets/${encodeURIComponent(targetId)}/heartbeat`,
    'PUT',
    secret,
    { profile },
    heartbeatResponseSchema
  );
}

async function request<T>(
  mailboxUrl: string,
  urlPath: string,
  method: string,
  secret: string | undefined,
  body: unknown,
  responseSchema: RuntimeSchema<T>
): Promise<T> {
  const res = await fetch(new URL(urlPath, mailboxUrl), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = protocolErrorSchema.safeParse(parsed);
    if (error.success) throw new EnrollmentApiError(res.status, error.data.code, error.data.message);
    throw new EnrollmentApiError(res.status, 'request_failed', `HTTP ${res.status}`);
  }
  // This response gets persisted as the overlay's local identity, so a
  // malformed or protocol-mismatched mailbox reply must fail loudly here
  // rather than write garbage to disk.
  return responseSchema.parse(parsed);
}
