import { app, globalShortcut, type BrowserWindow } from 'electron';
import { config } from './config';
import { createOverlayWindow } from './overlay-window';
import { InteractionMode } from './interaction';
import { registerIpc } from './ipc';

// `--start-interactive` boots straight into interactive mode, handy when you
// want to poke at the UI without reaching for the shortcut.
const startInteractive =
  config.startInteractive || process.argv.includes('--start-interactive');

let win: BrowserWindow | null = null;
let mode: InteractionMode | null = null;

// One overlay is enough; a second copy would just fight for always-on-top.
// Say so before exiting -- an instant silent exit is otherwise baffling.
if (!app.requestSingleInstanceLock()) {
  console.warn('[overlay] already running; focusing the existing window instead');
  app.quit();
}

app.on('second-instance', () => win?.show());

function registerShortcuts(): void {
  const { toggleInteractive, toggleVisibility, quit } = config.shortcuts;

  const bind = (accelerator: string, handler: () => void): void => {
    if (!accelerator) return;
    if (!globalShortcut.register(accelerator, handler)) {
      console.warn(
        `[overlay] could not register "${accelerator}" -- another app probably ` +
          'owns it. Change it in src/main/config.ts.'
      );
    }
  };

  bind(toggleInteractive, () => mode?.toggle());
  bind(toggleVisibility, () => {
    if (!win || !mode) return;
    if (win.isVisible()) {
      win.hide();
    } else {
      win.showInactive();
      // Coming back from hidden, re-assert the mode so the OS-level
      // click-through flag matches what the UI is showing.
      mode.broadcast();
    }
  });
  bind(quit, () => app.quit());
}

// A packaged app has nowhere obvious to show a stack trace, and a swallowed
// startup error looks identical to "quit immediately for no reason" -- so be
// loud about it.
process.on('uncaughtException', (err) => {
  console.error('[overlay] uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[overlay] unhandled rejection:', err);
});

app.whenReady().then(() => {
  if (process.platform === 'darwin' && config.hideDockIcon) {
    void app.dock?.hide();
  }

  win = createOverlayWindow();
  mode = new InteractionMode(win, startInteractive);
  registerIpc({ win, mode });
  registerShortcuts();

  // Re-send the mode once the page is live, so a reload cannot leave the
  // indicator out of sync with reality.
  win.webContents.on('did-finish-load', () => mode?.broadcast());

  win.on('closed', () => {
    win = null;
    mode = null;
  });
}).catch((err: unknown) => {
  console.error('[overlay] failed to start:', err);
  app.exit(1);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// An overlay with no window has no purpose -- quit on all platforms,
// including macOS.
app.on('window-all-closed', () => app.quit());
