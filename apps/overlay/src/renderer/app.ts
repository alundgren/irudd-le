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
