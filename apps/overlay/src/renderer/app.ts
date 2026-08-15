/**
 * The outer renderer is trusted local code. Published HTML stays inside the
 * opaque sandboxed iframe and never receives this preload bridge.
 */

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

const stagedRevisions = new Map<string, { revisionId: string; iframe: HTMLIFrameElement; deadlineAt: number }>();
const discardedAttempts = new Set<string>();

window.overlay.revisions.onStage(({ attemptId, revision, deadlineAt }) => {
  void stageRevision(attemptId, revision, deadlineAt).then(
    () => window.overlay.revisions.completeStage({ attemptId, revisionId: revision.id, staged: true }),
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
  window.overlay.revisions.completeCommit({ attemptId, revisionId: staged.revisionId, activated: true });
});

window.overlay.revisions.onDiscard((attemptId) => {
  discardedAttempts.add(attemptId);
  stagedRevisions.get(attemptId)?.iframe.remove();
  stagedRevisions.delete(attemptId);
});

async function stageRevision(attemptId: string, revision: RevisionActivation, deadlineAt: number): Promise<void> {
  if (revision.assetIds.length > 0) throw new Error('Required assets cannot be staged yet');
  if (discardedAttempts.has(attemptId)) throw new Error('The activation attempt was discarded');
  const staged = document.createElement('iframe');
  staged.setAttribute('sandbox', '');
  staged.referrerPolicy = 'no-referrer';
  staged.title = 'Staged published overlay content';
  staged.setAttribute('aria-hidden', 'true');
  staged.style.cssText = 'position:fixed; left:-100000px; top:-100000px; width:1px; height:1px; border:0; pointer-events:none';
  staged.srcdoc = sandboxedDocument(revision.html);

  try {
    await new Promise<void>((resolve, reject) => {
      staged.addEventListener('load', () => resolve(), { once: true });
      staged.addEventListener('error', () => reject(new Error('The staged iframe failed to load')), { once: true });
      document.body.append(staged);
    });
  } catch (error: unknown) {
    staged.remove();
    throw error;
  }

  // The main-process timeout only stops waiting; the renderer owns the actual
  // visible mutation, so it independently refuses a candidate after budget.
  if (discardedAttempts.has(attemptId) || Date.now() > deadlineAt) {
    staged.remove();
    throw new Error('The staged iframe missed its activation deadline');
  }
  stagedRevisions.set(attemptId, { revisionId: revision.id, iframe: staged, deadlineAt });
}

function sandboxedDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; font-src data:; form-action 'none'; img-src data: blob:; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'"></head><body>${html}</body></html>`;
}
