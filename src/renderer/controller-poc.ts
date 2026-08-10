/**
 * Disposable acceptance-test panel for issue #18 (Windows GameInput bridge).
 * Consumes the normalized readings the main process pushes over
 * `onControllerReading` -- D-pad, A, left-stick, per the bridge's scope --
 * shows live state, logs button edges, and drives move mode. Mirrors the
 * renderer-only POC from issue #16, but the controller data now comes from
 * the native bridge instead of `navigator.getGamepads()`, since #16 found
 * the renderer API stops reporting once Last Epoch, not the overlay, has
 * focus. See docs/research/xbox-controller-overlay-feasibility.md.
 */

import { must } from './app';

const MOVE_PIXELS_PER_TICK = 6;
const LOG_LIMIT = 12;

let statusEl: HTMLElement;
let moveEl: HTMLElement;
let logEl: HTMLElement;

let wasDpadUp = false;
let wasDpadDown = false;
let wasDpadLeft = false;
let wasDpadRight = false;
let wasA = false;
let wasMoving = false;

function log(message: string): void {
  const line = document.createElement('li');
  line.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
  logEl.prepend(line);
  while (logEl.children.length > LOG_LIMIT) {
    logEl.lastElementChild?.remove();
  }
}

function logEdge(label: string, pressed: boolean, wasPressed: boolean): void {
  if (pressed && !wasPressed) log(label);
}

function applyReading(reading: ControllerReading): void {
  if (!reading.connected) {
    statusEl.textContent = 'no controller detected';
    moveEl.textContent = 'off';
    wasDpadUp = false;
    wasDpadDown = false;
    wasDpadLeft = false;
    wasDpadRight = false;
    wasA = false;
    wasMoving = false;
    return;
  }

  statusEl.textContent =
    `connected — LS: (${reading.leftStickX.toFixed(2)}, ${reading.leftStickY.toFixed(2)})`;

  logEdge('D-pad up', reading.dpadUp, wasDpadUp);
  logEdge('D-pad down', reading.dpadDown, wasDpadDown);
  logEdge('D-pad left', reading.dpadLeft, wasDpadLeft);
  logEdge('D-pad right', reading.dpadRight, wasDpadRight);
  logEdge('A', reading.aPressed, wasA);
  wasDpadUp = reading.dpadUp;
  wasDpadDown = reading.dpadDown;
  wasDpadLeft = reading.dpadLeft;
  wasDpadRight = reading.dpadRight;
  wasA = reading.aPressed;

  // Move mode: hold D-pad left + right together, a chord unlikely to happen
  // by accident during play, then push the left stick to drag the overlay --
  // without ever focusing it. Limited to D-pad/A/left-stick because that is
  // the whole normalized surface the native bridge reports (issue #18).
  const moving = reading.dpadLeft && reading.dpadRight;
  if (moving !== wasMoving) {
    log(moving ? 'move mode: on (D-pad left+right held)' : 'move mode: off');
    wasMoving = moving;
  }
  moveEl.textContent = moving ? 'on' : 'off';

  if (moving && (reading.leftStickX !== 0 || reading.leftStickY !== 0)) {
    window.overlay.moveBy(
      reading.leftStickX * MOVE_PIXELS_PER_TICK,
      reading.leftStickY * MOVE_PIXELS_PER_TICK
    );
  }
}

export function initControllerPoc(status: ControllerBridgeStatus): void {
  statusEl = must('controller-status');
  moveEl = must('controller-move');
  logEl = must('controller-log');

  if (status !== 'active') {
    statusEl.textContent =
      status === 'unsupported'
        ? 'Windows only'
        : 'native bridge not built yet — see native/gameinput-bridge/README.md';
    return;
  }

  window.overlay.onControllerReading(applyReading);
}
