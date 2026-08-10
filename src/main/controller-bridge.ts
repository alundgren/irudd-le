import path from 'node:path';
import type { BrowserWindow } from 'electron';

const POLL_INTERVAL_MS = 16; // ~60 Hz, per the research note's 30-60 Hz guidance.

const DISCONNECTED_READING: ControllerReading = {
  connected: false,
  dpadUp: false,
  dpadDown: false,
  dpadLeft: false,
  dpadRight: false,
  aPressed: false,
  leftStickX: 0,
  leftStickY: 0,
};

interface NativeBridge {
  poll(): ControllerReading;
}

function loadNativeBridge(): NativeBridge | null {
  if (process.platform !== 'win32') return null;

  // Compiled by hand on the Windows dev PC -- see native/gameinput-bridge/README.md.
  // __dirname here is build/main, so this resolves to <repo>/native/gameinput-bridge
  // regardless of cwd.
  const addonPath = path.join(
    __dirname,
    '..',
    '..',
    'native',
    'gameinput-bridge',
    'build',
    'Release',
    'gameinput_bridge.node'
  );

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(addonPath) as NativeBridge;
  } catch (error: unknown) {
    console.warn('[controller] gameinput-bridge addon not available:', error);
    return null;
  }
}

/**
 * Reads the Xbox controller through the Windows-only GameInput native addon
 * and pushes normalized readings to the renderer, mirroring the
 * `overlay:mode-changed` push pattern. Read-only: never intercepts or
 * remaps the controller, and never touches window focus. See issue #18 and
 * docs/research/xbox-controller-overlay-feasibility.md.
 */
export class ControllerBridge {
  private readonly win: BrowserWindow;
  private readonly native: NativeBridge | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(win: BrowserWindow) {
    this.win = win;
    this.native = loadNativeBridge();
  }

  status(): ControllerBridgeStatus {
    if (process.platform !== 'win32') return 'unsupported';
    return this.native ? 'active' : 'unavailable';
  }

  start(): void {
    if (!this.native || this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    if (!this.native || this.win.isDestroyed()) return;

    let reading: ControllerReading;
    try {
      reading = this.native.poll();
    } catch (error: unknown) {
      console.warn('[controller] poll failed:', error);
      reading = DISCONNECTED_READING;
    }

    this.win.webContents.send('controller:reading', reading);
  }
}
