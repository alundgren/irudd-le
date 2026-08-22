import { screen, type BrowserWindow } from 'electron';
import { config } from './config';
import { resizeWithinWorkArea } from './window-state';

/**
 * Owns the one piece of state that matters in v1: is the overlay currently
 * swallowing mouse input, or letting it fall through to the game?
 *
 *   click-through (default) -> mouse events go to whatever is underneath
 *   interactive             -> you can scroll, click and type in the overlay
 *
 * The renderer never sets this itself; it asks, and it gets told when it
 * changes. Keeps a single source of truth in the main process.
 */
export class InteractionMode {
  private readonly win: BrowserWindow;
  private interactive: boolean;
  private resizeStart: { width: number; height: number } | null = null;

  constructor(win: BrowserWindow, startInteractive = false) {
    this.win = win;
    // Start from the opposite value so the first apply() always runs the
    // OS-level calls rather than short-circuiting.
    this.interactive = !startInteractive;
    this.apply(startInteractive);
  }

  apply(interactive: boolean): boolean {
    if (this.interactive === interactive) return this.interactive;
    this.interactive = interactive;
    if (!interactive) this.resizeStart = null;

    if (interactive) {
      this.win.setIgnoreMouseEvents(false);
      // Without focus, clicks land but keystrokes go nowhere.
      this.win.focus();
    } else {
      // forward: true still delivers mouse-move to the renderer, so hover
      // styling keeps working while clicks pass through.
      this.win.setIgnoreMouseEvents(true, { forward: true });
      this.win.blur();
    }

    this.broadcast();
    return this.interactive;
  }

  toggle(): boolean {
    return this.apply(!this.interactive);
  }

  /** A recovery-only gesture. The renderer supplies a delta, never bounds. */
  beginResize(): boolean {
    if (!this.interactive) return false;
    const { width, height } = this.win.getBounds();
    this.resizeStart = { width, height };
    return true;
  }

  resize(delta: unknown): void {
    if (!this.resizeStart || !this.interactive || !isResizeDelta(delta)) return;
    const bounds = this.win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const size = resizeWithinWorkArea(bounds, this.resizeStart, delta, area, {
      width: config.window.minimumWidth,
      height: config.window.minimumHeight,
    });
    this.win.setSize(size.width, size.height);
  }

  endResize(): void {
    this.resizeStart = null;
  }

  broadcast(): void {
    if (this.win.isDestroyed()) return;
    this.win.webContents.send('overlay:mode-changed', this.state());
  }

  state(): OverlayState {
    return { interactive: this.interactive };
  }
}

function isResizeDelta(value: unknown): value is { width: number; height: number } {
  if (!value || typeof value !== 'object') return false;
  const delta = value as Record<string, unknown>;
  return ['width', 'height'].every((key) =>
    typeof delta[key] === 'number' && Number.isFinite(delta[key]) && Math.abs(delta[key]) <= 4096
  );
}
