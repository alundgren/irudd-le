/**
 * Disposable prototype for the "controller input while Last Epoch stays
 * focused" acceptance test. See
 * docs/research/xbox-controller-overlay-feasibility.md for the design this
 * follows and the eventual GameInput fallback if this fails on the real
 * hardware/game combination.
 *
 * Reads navigator.getGamepads() every frame (no extra runtime code, per the
 * research note), shows live readings, logs D-pad/A edges, and -- while a
 * held chord is down -- drags the overlay via IPC without ever focusing it.
 * Delete this module once the acceptance test's findings are recorded on the
 * originating issue.
 */

import { must } from './app';

const DEADZONE = 0.2;
const MOVE_PIXELS_PER_FRAME = 6;
const LOG_LIMIT = 12;

// Standard gamepad mapping: https://www.w3.org/TR/gamepad/#remapping
const BUTTON_A = 0;
const BUTTON_LB = 4;
const BUTTON_RB = 5;
const MOVE_CHORD = [BUTTON_LB, BUTTON_RB];
const DPAD = [
  { index: 12, label: 'D-pad up' },
  { index: 13, label: 'D-pad down' },
  { index: 14, label: 'D-pad left' },
  { index: 15, label: 'D-pad right' },
] as const;

let statusEl: HTMLElement;
let moveEl: HTMLElement;
let logEl: HTMLElement;
let wasPressed: boolean[] = [];
let wasMoving = false;

function applyDeadzone(value: number): number {
  return Math.abs(value) < DEADZONE ? 0 : value;
}

function log(message: string): void {
  const line = document.createElement('li');
  line.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
  logEl.prepend(line);
  while (logEl.children.length > LOG_LIMIT) {
    logEl.lastElementChild?.remove();
  }
}

function pickGamepad(): Gamepad | null {
  for (const pad of navigator.getGamepads()) {
    if (pad) return pad;
  }
  return null;
}

function tick(): void {
  const pad = pickGamepad();

  if (!pad) {
    statusEl.textContent = 'no controller — press any button to connect';
    moveEl.textContent = 'off';
    wasPressed = [];
    wasMoving = false;
    requestAnimationFrame(tick);
    return;
  }

  const lx = applyDeadzone(pad.axes[0] ?? 0);
  const ly = applyDeadzone(pad.axes[1] ?? 0);
  statusEl.textContent =
    `${pad.id} — LS: (${lx.toFixed(2)}, ${ly.toFixed(2)})`;

  for (const { index, label } of DPAD) {
    const pressed = pad.buttons[index]?.pressed ?? false;
    if (pressed && !wasPressed[index]) log(label);
    wasPressed[index] = pressed;
  }
  const aPressed = pad.buttons[BUTTON_A]?.pressed ?? false;
  if (aPressed && !wasPressed[BUTTON_A]) log('A');
  wasPressed[BUTTON_A] = aPressed;

  const moving = MOVE_CHORD.every((index) => pad.buttons[index]?.pressed);
  if (moving !== wasMoving) {
    log(moving ? 'move mode: on (LB+RB held)' : 'move mode: off');
    wasMoving = moving;
  }
  moveEl.textContent = moving ? 'on' : 'off';

  if (moving && (lx !== 0 || ly !== 0)) {
    window.overlay.moveBy(lx * MOVE_PIXELS_PER_FRAME, ly * MOVE_PIXELS_PER_FRAME);
  }

  requestAnimationFrame(tick);
}

export function initControllerPoc(): void {
  statusEl = must('controller-status');
  moveEl = must('controller-move');
  logEl = must('controller-log');

  window.addEventListener('gamepadconnected', (event) => {
    log(`connected: ${event.gamepad.id}`);
  });
  window.addEventListener('gamepaddisconnected', (event) => {
    log(`disconnected: ${event.gamepad.id}`);
  });

  requestAnimationFrame(tick);
}
