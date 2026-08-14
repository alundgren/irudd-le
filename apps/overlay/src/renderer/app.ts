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
