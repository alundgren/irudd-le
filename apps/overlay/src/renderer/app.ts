/**
 * The outer renderer is trusted local code. Published HTML stays inside the
 * opaque sandboxed iframe and never receives this preload bridge.
 */
import { sandboxedDocument } from './asset-sandbox.js';

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`[overlay] missing #${id}`);
  return element as T;
}

const setup = must<HTMLElement>('local-setup');
const resume = must<HTMLButtonElement>('resume-content');
const quit = must<HTMLButtonElement>('quit-overlay');

function applyMode(state: OverlayState): void {
  document.body.dataset.mode = state.interactive ? 'interactive' : 'click-through';
  setup.hidden = !state.interactive;
}

resume.addEventListener('click', () => {
  void window.overlay.setInteractive(false);
});

quit.addEventListener('click', () => {
  window.overlay.quit();
});

window.overlay.onModeChanged(applyMode);

void window.overlay.getState().then((state) => {
  if (state) applyMode(state);
});

const enrollmentForm = must<HTMLElement>('enrollment-form');
const mailboxUrlInput = must<HTMLInputElement>('mailbox-url');
const clientNameInput = must<HTMLInputElement>('client-name');
const enrollBtn = must<HTMLButtonElement>('enroll-btn');
const enrollmentStatus = must<HTMLElement>('enrollment-status');
const enrollmentHeading = must<HTMLElement>('enrollment-heading');
const enrollmentDetail = must<HTMLElement>('enrollment-detail');
const pairingCodeEl = must<HTMLElement>('pairing-code');
const reEnrollBtn = must<HTMLButtonElement>('re-enroll-btn');
const enrollmentError = must<HTMLElement>('enrollment-error');

function applyEnrollment(info: EnrollmentInfo): void {
  enrollmentError.hidden = !info.error;
  enrollmentError.textContent = info.error ?? '';

  if (info.status === 'unenrolled') {
    enrollmentForm.hidden = false;
    enrollmentStatus.hidden = true;
    return;
  }

  enrollmentForm.hidden = true;
  enrollmentStatus.hidden = false;

  if (info.status === 'pending') {
    enrollmentHeading.textContent = 'Waiting to be paired';
    enrollmentDetail.textContent = info.pairingCode
      ? 'Give this code to whoever is creating the channel:'
      : 'Waiting for a pairing code…';
    pairingCodeEl.hidden = !info.pairingCode;
    pairingCodeEl.textContent = info.pairingCode ?? '';
  } else {
    enrollmentHeading.textContent = 'Paired';
    enrollmentDetail.textContent = `Displaying channel "${info.channel ?? ''}".`;
    pairingCodeEl.hidden = true;
    pairingCodeEl.textContent = '';
  }
}

enrollBtn.addEventListener('click', () => {
  const mailboxUrl = mailboxUrlInput.value.trim();
  const clientName = clientNameInput.value.trim();
  if (!mailboxUrl || !clientName) return;
  enrollBtn.disabled = true;
  void window.overlay.enrollment
    .enroll({ mailboxUrl, clientName })
    .then((info) => {
      if (info) applyEnrollment(info);
    })
    .finally(() => {
      enrollBtn.disabled = false;
    });
});

reEnrollBtn.addEventListener('click', () => {
  void window.overlay.enrollment.reEnroll().then((info) => {
    if (info) applyEnrollment(info);
  });
});

window.overlay.enrollment.onChanged(applyEnrollment);

void window.overlay.enrollment.getState().then((info) => {
  if (info) applyEnrollment(info);
});

const stagedRevisions = new Map<string, { revisionId: string; iframe: HTMLIFrameElement; deadlineAt: number; metrics: RenderMetrics }>();
const discardedAttempts = new Set<string>();
const cancelStaging = new Map<string, () => void>();

window.overlay.revisions.onStage(({ attemptId, revision, deadlineAt }) => {
  void stageRevision(attemptId, revision, deadlineAt).then(
    (metrics) => window.overlay.revisions.completeStage({ attemptId, revisionId: revision.id, staged: true, metrics }),
    (error: unknown) => window.overlay.revisions.completeStage({
      attemptId,
      revisionId: revision.id,
      staged: false,
      error: error instanceof Error ? error.message : 'Unknown renderer staging failure',
    })
  );
});

window.overlay.revisions.onCommit((attemptId) => {
  const staged = stagedRevisions.get(attemptId);
  if (!staged || discardedAttempts.has(attemptId) || Date.now() > staged.deadlineAt) {
    staged?.iframe.remove();
    stagedRevisions.delete(attemptId);
    window.overlay.revisions.completeCommit({
      attemptId,
      revisionId: staged?.revisionId ?? '',
      activated: false,
      error: 'The staged revision is no longer valid',
    });
    return;
  }
  const current = must<HTMLIFrameElement>('revision-content');
  stagedRevisions.delete(attemptId);
  staged.iframe.id = 'revision-content';
  staged.iframe.title = 'Published overlay content';
  staged.iframe.removeAttribute('aria-hidden');
  staged.iframe.removeAttribute('style');
  current.replaceWith(staged.iframe);
  window.overlay.revisions.completeCommit({ attemptId, revisionId: staged.revisionId, activated: true, metrics: staged.metrics });
});

window.overlay.revisions.onDiscard((attemptId) => {
  discardedAttempts.add(attemptId);
  cancelStaging.get(attemptId)?.();
  stagedRevisions.get(attemptId)?.iframe.remove();
  stagedRevisions.delete(attemptId);
});

async function stageRevision(attemptId: string, revision: RevisionActivation, deadlineAt: number): Promise<RenderMetrics> {
  if (discardedAttempts.has(attemptId)) throw new Error('The activation attempt was discarded');
  const staged = document.createElement('iframe');
  // The nonce-bound bootstrap is the only script CSP permits. Published
  // scripts do not know that nonce, and the iframe remains an opaque origin.
  staged.setAttribute('sandbox', 'allow-scripts');
  staged.referrerPolicy = 'no-referrer';
  staged.title = 'Staged published overlay content';
  staged.setAttribute('aria-hidden', 'true');
  const visible = must<HTMLIFrameElement>('revision-content').getBoundingClientRect();
  const width = Math.max(1, Math.round(visible.width));
  const height = Math.max(1, Math.round(visible.height));
  const measurementToken = crypto.randomUUID();
  staged.style.cssText = 'position:fixed; left:-100000px; top:-100000px; width:' + width + 'px; height:' + height + 'px; border:0; pointer-events:none';
  staged.srcdoc = sandboxedDocument(revision.html, revision.assetSources, measurementToken);

  try {
    const metrics = await new Promise<RenderMetrics>((resolve, reject) => {
      const onMessage = (event: MessageEvent<unknown>): void => {
        if (event.source !== staged.contentWindow) return;
        if (isRenderFailureMessage(event.data, measurementToken)) {
          cleanup();
          reject(new Error(event.data.error));
          return;
        }
        if (!isRenderMetricsMessage(event.data, measurementToken)) return;
        cleanup();
        resolve(event.data.metrics);
      };
      const cleanup = (): void => {
        window.removeEventListener('message', onMessage);
        cancelStaging.delete(attemptId);
      };
      cancelStaging.set(attemptId, () => {
        cleanup();
        reject(new Error('The activation attempt was discarded'));
      });
      staged.addEventListener('error', () => {
        cleanup();
        reject(new Error('The staged iframe failed to load'));
      }, { once: true });
      window.addEventListener('message', onMessage);
      document.body.append(staged);
    });
    if (discardedAttempts.has(attemptId) || Date.now() > deadlineAt) {
      staged.remove();
      throw new Error('The staged iframe missed its activation deadline');
    }
    stagedRevisions.set(attemptId, { revisionId: revision.id, iframe: staged, deadlineAt, metrics });
    return metrics;
  } catch (error: unknown) {
    staged.remove();
    throw error;
  }
}

function isRenderMetricsMessage(value: unknown, token: string): value is { token: string; metrics: RenderMetrics } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type !== 'overlay:render-metrics' || message.token !== token || !message.metrics || typeof message.metrics !== 'object') return false;
  const metrics = message.metrics as Record<string, unknown>;
  return ['width', 'height', 'scrollWidth', 'scrollHeight'].every((key) => typeof metrics[key] === 'number' && Number.isFinite(metrics[key]) && metrics[key] >= 0);
}

function isRenderFailureMessage(value: unknown, token: string): value is { token: string; error: string } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.type === 'overlay:render-failure' && message.token === token && typeof message.error === 'string';
}
