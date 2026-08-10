import { app, ipcMain, screen, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { config } from './config';
import type { InteractionMode } from './interaction';
import type { UpdateManager } from './update';

/**
 * Every channel the renderer can reach, in one place.
 *
 * Convention: `namespace:verb-noun`. v1 only needs `overlay:*`. When v2 (local
 * Ollama) and v3 (screen capture) land they get their own namespaces --
 * `ollama:chat`, `capture:analyze` -- registered from their own module and
 * wired into the same preload bridge. Nothing here needs to change for that.
 */
export function registerIpc({
  win,
  mode,
  updater,
}: {
  win: BrowserWindow;
  mode: InteractionMode;
  updater: UpdateManager;
}): void {
  // Ignore anything that did not come from our own overlay window.
  const fromOverlay = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    event.sender === win.webContents;

  ipcMain.handle('overlay:get-state', (event): OverlayInfo | null => {
    if (!fromOverlay(event)) return null;
    return {
      ...mode.state(),
      // Passed through so the UI can show the real keys instead of hardcoding
      // them in two places.
      shortcuts: config.shortcuts,
      platform: process.platform,
      version: app.getVersion(),
      isDev: !app.isPackaged,
      updateStatus: updater.state(),
    };
  });

  ipcMain.handle(
    'overlay:set-interactive',
    (event, interactive: unknown): OverlayState | null => {
      if (!fromOverlay(event)) return null;
      mode.apply(Boolean(interactive));
      return mode.state();
    }
  );

  ipcMain.handle('overlay:toggle-interactive', (event): OverlayState | null => {
    if (!fromOverlay(event)) return null;
    mode.toggle();
    return mode.state();
  });

  ipcMain.on('overlay:quit', (event) => {
    if (!fromOverlay(event)) return;
    app.quit();
  });

  // Controller-input prototype: moves the window without ever calling
  // win.focus(), matching the "read, don't activate" design in
  // docs/research/xbox-controller-overlay-feasibility.md.
  ipcMain.on('overlay:move-by', (event, dx: unknown, dy: unknown) => {
    if (!fromOverlay(event)) return;
    if (typeof dx !== 'number' || typeof dy !== 'number') return;

    const [x = 0, y = 0] = win.getPosition();
    const [width = 0, height = 0] = win.getSize();
    const { workArea } = screen.getDisplayMatching({ x, y, width, height });

    const clamp = (value: number, min: number, max: number): number =>
      Math.min(Math.max(value, min), max);

    win.setPosition(
      Math.round(clamp(x + dx, workArea.x, workArea.x + workArea.width - width)),
      Math.round(clamp(y + dy, workArea.y, workArea.y + workArea.height - height))
    );
  });
}
