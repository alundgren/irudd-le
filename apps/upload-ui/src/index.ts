import {
  PROTOCOL_VERSION,
  channelSchema,
  protocolErrorSchema,
  revisionSchema,
  targetProfileSchema,
  type Revision,
  type TargetProfile,
} from '@irudd-le/protocol';

export class UploadApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'UploadApiError';
  }
}

export type TargetState =
  | { state: 'paired'; profile: TargetProfile }
  | { state: 'unbound' };

export interface PublicationInput {
  channel: string;
  profileVersion: number;
  title: string;
  description: string;
  html: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Thin browser-facing client for the canonical mailbox API. It deliberately
 * receives a session credential from the mounted form and never persists it.
 */
export class UploadClient {
  constructor(
    private readonly mailboxUrl: string,
    private readonly secret: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly createRevisionId: () => string = () => crypto.randomUUID()
  ) {}

  async loadTarget(channel: string): Promise<TargetState> {
    this.assertChannel(channel);
    const response = await this.fetcher(this.url(`/v1/channels/${encodeURIComponent(channel)}/profile`), {
      headers: { authorization: `Bearer ${this.secret}` },
    });
    if (response.ok) return { state: 'paired', profile: targetProfileSchema.parse(await response.json()) };

    const error = await apiError(response);
    if (error.status === 404 && error.code === 'no_profile') return { state: 'unbound' };
    throw error;
  }

  async publish(input: PublicationInput): Promise<Revision> {
    this.assertChannel(input.channel);
    const revision = revisionSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      id: this.createRevisionId(),
      channel: input.channel,
      profileVersion: input.profileVersion,
      title: input.title,
      description: input.description,
      html: input.html,
      assetIds: [],
    });
    const response = await this.fetcher(this.url(`/v1/channels/${encodeURIComponent(revision.channel)}/revisions/current`), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(revision),
    });
    if (!response.ok) throw await apiError(response);
    return revisionSchema.parse(await response.json());
  }

  private assertChannel(channel: string): void {
    channelSchema.parse({ protocolVersion: PROTOCOL_VERSION, id: channel, name: 'Upload UI' });
  }

  private url(path: string): URL {
    return new URL(path, this.mailboxUrl);
  }
}

async function apiError(response: Response): Promise<UploadApiError> {
  const parsed = protocolErrorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? new UploadApiError(response.status, parsed.data.code, parsed.data.message)
    : new UploadApiError(response.status, 'request_failed', `HTTP ${response.status}`);
}

export function mountUploadUi(root: HTMLElement): void {
  root.innerHTML = shell;

  const form = must<HTMLFormElement>(root, 'upload-form');
  const mailboxUrl = must<HTMLInputElement>(root, 'mailbox-url');
  const channel = must<HTMLInputElement>(root, 'channel');
  const secret = must<HTMLInputElement>(root, 'secret');
  const title = must<HTMLInputElement>(root, 'title');
  const description = must<HTMLTextAreaElement>(root, 'description');
  const html = must<HTMLTextAreaElement>(root, 'html');
  const file = must<HTMLInputElement>(root, 'html-file');
  const publish = must<HTMLButtonElement>(root, 'publish');
  const target = must<HTMLButtonElement>(root, 'load-target');
  const status = must<HTMLElement>(root, 'status');
  const previewStatus = must<HTMLElement>(root, 'preview-status');
  const previewStage = must<HTMLElement>(root, 'preview-stage');
  const preview = must<HTMLIFrameElement>(root, 'preview');

  let loadedTarget: { context: string; profile: TargetProfile } | null = null;

  const client = (): UploadClient => new UploadClient(mailboxUrl.value.trim(), secret.value.trim());
  const targetContext = (): string => [mailboxUrl.value.trim(), channel.value.trim(), secret.value.trim()].join('\n');
  const showError = (error: unknown): void => {
    status.dataset.kind = 'error';
    status.textContent = error instanceof Error ? error.message : 'The request failed';
  };

  const showPreview = (): void => {
    const profile = loadedTarget?.context === targetContext() ? loadedTarget.profile : null;
    if (!profile) {
      preview.hidden = true;
      previewStage.style.height = '';
      previewStatus.textContent = 'No paired target — a pixel-accurate preview is unavailable.';
      return;
    }
    const availableWidth = Math.max(1, previewStage.clientWidth || 640);
    const availableHeight = 420;
    const scale = Math.min(1, availableWidth / profile.contentBox.width, availableHeight / profile.contentBox.height);
    preview.hidden = false;
    preview.style.width = `${profile.contentBox.width}px`;
    preview.style.height = `${profile.contentBox.height}px`;
    preview.style.transform = `scale(${scale})`;
    preview.style.transformOrigin = 'top left';
    preview.style.pointerEvents = 'none';
    previewStage.style.height = `${Math.ceil(profile.contentBox.height * scale)}px`;
    preview.srcdoc = previewDocument(html.value);
    previewStatus.textContent = `Previewing the paired target at ${profile.contentBox.width}×${profile.contentBox.height}.`;
  };

  target.addEventListener('click', () => {
    loadedTarget = null;
    showPreview();
    target.disabled = true;
    status.textContent = '';
    const context = targetContext();
    void client().loadTarget(channel.value.trim()).then((state) => {
      if (context !== targetContext()) return;
      loadedTarget = state.state === 'paired' ? { context, profile: state.profile } : null;
      showPreview();
    }, showError).finally(() => {
      target.disabled = false;
    });
  });

  html.addEventListener('input', showPreview);
  for (const input of [mailboxUrl, channel, secret]) {
    input.addEventListener('input', () => {
      loadedTarget = null;
      showPreview();
    });
  }
  file.addEventListener('change', () => {
    const selected = file.files?.[0];
    if (!selected) return;
    void selected.text().then((contents) => {
      html.value = contents;
      showPreview();
    }, showError);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    publish.disabled = true;
    status.textContent = '';
    void client().publish({
      channel: channel.value.trim(),
      profileVersion: loadedTarget?.context === targetContext() ? loadedTarget.profile.version : 1,
      title: title.value.trim(),
      description: description.value.trim(),
      html: html.value,
    }).then((revision) => {
      status.dataset.kind = 'success';
      status.textContent = `Published “${revision.title}” atomically.`;
    }, showError).finally(() => {
      publish.disabled = false;
    });
  });

  window.addEventListener('resize', showPreview);
  showPreview();
}

function must<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const element = root.querySelector(`#${id}`);
  if (!element) throw new Error(`[upload-ui] missing #${id}`);
  return element as T;
}

/** The document has an opaque, scriptless sandbox and a CSP that permits no network or host bridge. */
export function previewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:"></head><body>${sanitizePreviewMarkup(html)}</body></html>`;
}

function sanitizePreviewMarkup(html: string): string {
  // A browser UI always has DOMParser. Failing closed keeps this security
  // boundary safe in non-browser hosts used by package consumers and tests.
  if (typeof DOMParser === 'undefined') return '';
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script, base, form, iframe, frame, object, embed, portal, meta[http-equiv="refresh"]').forEach((element) => element.remove());
  parsed.querySelectorAll('[href], [action], [formaction], [target], [srcset]').forEach((element) => {
    element.removeAttribute('href');
    element.removeAttribute('action');
    element.removeAttribute('formaction');
    element.removeAttribute('target');
    element.removeAttribute('srcset');
  });
  parsed.querySelectorAll<HTMLElement>('[src]').forEach((element) => {
    const source = element.getAttribute('src') ?? '';
    if (!source.startsWith('data:') && !source.startsWith('blob:')) element.removeAttribute('src');
  });
  return parsed.body.innerHTML;
}

const shell = `
  <form id="upload-form" novalidate>
    <h1>Publish HTML</h1>
    <label>Mailbox URL <input id="mailbox-url" type="url" required placeholder="https://mailbox.example/"></label>
    <label>Channel <input id="channel" required pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="main"></label>
    <label>Publisher credential <input id="secret" type="password" required autocomplete="off"></label>
    <button id="load-target" type="button">Load target profile</button>
    <p id="preview-status" role="status"></p>
    <label>Title <input id="title" required maxlength="200"></label>
    <label>Description <textarea id="description" maxlength="2000"></textarea></label>
    <label>Paste HTML <textarea id="html" required></textarea></label>
    <label>or choose an HTML file <input id="html-file" type="file" accept="text/html,.html,.htm"></label>
    <section id="preview-stage" aria-label="Target preview"><iframe id="preview" title="Sandboxed target preview" sandbox="" referrerpolicy="no-referrer"></iframe></section>
    <button id="publish" type="submit">Publish</button>
    <p id="status" role="status" aria-live="polite"></p>
  </form>`;
