import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { config } from './config';
import { loadOverlayBounds, persistOverlayBounds } from './window-state';

const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');

/**
 * Where the window should sit, given the *work area* of the display the cursor
 * is currently on (work area excludes the macOS menu bar / Windows taskbar, so
 * the overlay never lands underneath them).
 */
export function cornerPosition(size: {
  width: number;
  height: number;
}): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const { corner, margin } = config.window;

  const left = area.x + margin;
  const right = area.x + area.width - size.width - margin;
  const top = area.y + margin;
  const bottom = area.y + area.height - size.height - margin;

  switch (corner) {
    case 'top-left':
      return { x: left, y: top };
    case 'bottom-left':
      return { x: left, y: bottom };
    case 'bottom-right':
      return { x: right, y: bottom };
    case 'top-right':
    default:
      return { x: right, y: top };
  }
}

/**
 * Creates the overlay: transparent, frameless, always on top.
 *
 * Deliberately a plain OS window drawn above the game -- no hooking, no
 * injection, no reading game memory. See README "Non-goals".
 */
export function createOverlayWindow(userDataDir: string): BrowserWindow {
  const { width, height, minimumWidth, minimumHeight, resizable } = config.window;
  const restored = loadOverlayBounds(userDataDir, { width: minimumWidth, height: minimumHeight });
  const { x, y } = restored ?? cornerPosition({ width, height });

  const win = new BrowserWindow({
    width: restored?.width ?? width,
    height: restored?.height ?? height,
    x,
    y,
    resizable,
    minWidth: minimumWidth,
    minHeight: minimumHeight,
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    // Nothing should ever steal focus from the game on launch.
    show: false,
    focusable: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The overlay only ever loads local files; no remote content.
      webSecurity: true,
    },
  });

  // 'screen-saver' is the highest sane level: it floats above other apps'
  // fullscreen windows on macOS, which the default 'floating' level does not.
  win.setAlwaysOnTop(true, 'screen-saver');

  // Follow the user across Spaces, and stay visible when another app is
  // fullscreen (macOS). Harmless no-op elsewhere.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // The iframe sandbox blocks a published document from escaping upward, and
  // this guard also prevents it from replacing even its own document (links,
  // meta refreshes, and any future browser navigation mechanism). This event
  // covers subframes as well as the outer renderer.
  win.webContents.on('will-frame-navigate', (event) => {
    event.preventDefault();
  });

  void win.loadFile(RENDERER_HTML);

  win.once('ready-to-show', () => {
    win.showInactive(); // show without taking focus
  });

  // External links would open inside the overlay otherwise.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  persistOverlayBounds(userDataDir, win);

  return win;
}
