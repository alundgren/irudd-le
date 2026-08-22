import { app, globalShortcut, type BrowserWindow } from 'electron';
import { config } from './config';
import { createOverlayWindow } from './overlay-window';
import { EnrollmentManager } from './enrollment';
import { loadEnrollment } from './enrollment-store';
import { InteractionMode } from './interaction';
import { registerIpc } from './ipc';
import { UpdateManager } from './update';

// A target with no channel yet has nothing useful to show at couch distance,
// so a pending/unenrolled overlay always boots into interactive mode to
// surface the first-run setup screen -- there is no sane default mailbox URL
// to fall back to (it is Pi-hosted and operator-specific).
const persistedEnrollment = loadEnrollment(app.getPath('userData'));
const needsSetup = !persistedEnrollment || persistedEnrollment.channel === null;

// `--start-interactive` boots straight into interactive mode, handy when you
// want to poke at the UI without reaching for the shortcut.
const startInteractive =
  config.startInteractive || process.argv.includes('--start-interactive') || needsSetup;

let win: BrowserWindow | null = null;
let mode: InteractionMode | null = null;
let updater: UpdateManager | null = null;
let enrollment: EnrollmentManager | null = null;

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

  win = createOverlayWindow(app.getPath('userData'));
  mode = new InteractionMode(win, startInteractive);
  updater = new UpdateManager(win);
  enrollment = new EnrollmentManager(win, app.getPath('userData'));
  registerIpc({ win, mode, updater, enrollment });
  registerShortcuts();
  updater.start();

  // Re-send the mode once the page is live, so a reload cannot leave the
  // indicator out of sync with reality. Enrollment measures the content box
  // from the same page, so it also waits until this point.
  win.webContents.on('did-finish-load', () => {
    mode?.broadcast();
    enrollment?.start();
  });

  win.on('closed', () => {
    win = null;
    mode = null;
    updater?.stop();
    updater = null;
    enrollment?.stop();
    enrollment = null;
  });
}).catch((err: unknown) => {
  console.error('[overlay] failed to start:', err);
  app.exit(1);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  updater?.stop();
});

// An overlay with no window has no purpose -- quit on all platforms,
// including macOS.
app.on('window-all-closed', () => app.quit());
