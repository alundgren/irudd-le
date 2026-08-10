import type { BrowserWindow } from 'electron';

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

  broadcast(): void {
    if (this.win.isDestroyed()) return;
    this.win.webContents.send('overlay:mode-changed', this.state());
  }

  state(): OverlayState {
    return { interactive: this.interactive };
  }
}
