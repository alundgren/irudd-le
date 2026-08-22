import { app, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { config } from './config';
import type { EnrollmentManager } from './enrollment';
import type { InteractionMode } from './interaction';
import type { UpdateManager } from './update';

/**
 * Every channel the renderer can reach, in one place.
 *
 * Convention: `namespace:verb-noun`. v1 only needs `overlay:*` plus
 * `enrollment:*` (issue #21). When v2 (local Ollama) and v3 (screen capture)
 * land they get their own namespaces -- `ollama:chat`, `capture:analyze` --
 * registered from their own module and wired into the same preload bridge.
 * Nothing here needs to change for that.
 */
export function registerIpc({
  win,
  mode,
  updater,
  enrollment,
}: {
  win: BrowserWindow;
  mode: InteractionMode;
  updater: UpdateManager;
  enrollment: EnrollmentManager;
}): void {
  // Ignore anything that did not come from our own overlay window.
  const fromOverlay = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    event.sender === win.webContents;

  ipcMain.handle('overlay:get-state', (event): OverlayInfo | null => {
    if (!fromOverlay(event)) return null;
    return {
      ...mode.state(),
      protocolVersion: config.protocolVersion,
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

  ipcMain.handle('overlay:begin-resize', (event): boolean => {
    if (!fromOverlay(event)) return false;
    return mode.beginResize();
  });

  ipcMain.on('overlay:resize', (event, delta: unknown) => {
    if (!fromOverlay(event)) return;
    mode.resize(delta);
  });

  ipcMain.on('overlay:end-resize', (event) => {
    if (!fromOverlay(event)) return;
    mode.endResize();
  });

  ipcMain.on('overlay:quit', (event) => {
    if (!fromOverlay(event)) return;
    app.quit();
  });

  ipcMain.handle('enrollment:get-state', (event): EnrollmentInfo | null => {
    if (!fromOverlay(event)) return null;
    return enrollment.info();
  });

  ipcMain.handle('enrollment:enroll', (event, input: unknown): Promise<EnrollmentInfo | null> | null => {
    if (!fromOverlay(event)) return null;
    const parsed = parseEnrollInput(input);
    if (!parsed) return null;
    return enrollment.enroll(parsed);
  });

  ipcMain.handle('enrollment:re-enroll', (event): EnrollmentInfo | null => {
    if (!fromOverlay(event)) return null;
    return enrollment.reEnroll();
  });
}

function parseEnrollInput(input: unknown): { mailboxUrl: string; clientName: string } | null {
  if (!input || typeof input !== 'object') return null;
  const { mailboxUrl, clientName } = input as Record<string, unknown>;
  if (typeof mailboxUrl !== 'string' || typeof clientName !== 'string') return null;
  if (mailboxUrl.trim().length === 0 || clientName.trim().length === 0) return null;
  return { mailboxUrl: mailboxUrl.trim(), clientName: clientName.trim() };
}
