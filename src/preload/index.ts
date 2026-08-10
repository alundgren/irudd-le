import { contextBridge, ipcRenderer } from 'electron';

/**
 * The entire surface the renderer gets. contextIsolation stays on and
 * nodeIntegration stays off, so this file is the only bridge -- if it is not
 * listed here, the UI cannot do it.
 *
 * Typed against OverlayApi (src/shared/types.d.ts), so preload and renderer
 * cannot drift apart silently.
 *
 * Future features get their own object on this bridge rather than widening
 * `overlay`, e.g. `ollama: { chat }` for v2 and `capture: { analyze }` for v3.
 */
const api: OverlayApi = {
  getState: () => ipcRenderer.invoke('overlay:get-state'),

  setInteractive: (interactive) =>
    ipcRenderer.invoke('overlay:set-interactive', interactive),

  toggleInteractive: () => ipcRenderer.invoke('overlay:toggle-interactive'),

  quit: () => ipcRenderer.send('overlay:quit'),

  moveBy: (dx, dy) => ipcRenderer.send('overlay:move-by', dx, dy),

  /**
   * Fired whenever click-through mode changes, from any source (shortcut, UI,
   * unhide).
   */
  onModeChanged: (handler) => {
    const listener = (_event: unknown, state: OverlayState): void =>
      handler(state);
    ipcRenderer.on('overlay:mode-changed', listener);
    return () => {
      ipcRenderer.removeListener('overlay:mode-changed', listener);
    };
  },

  onUpdateStatusChanged: (handler) => {
    const listener = (_event: unknown, status: UpdateStatus): void =>
      handler(status);
    ipcRenderer.on('update:status-changed', listener);
    return () => {
      ipcRenderer.removeListener('update:status-changed', listener);
    };
  },

  onControllerReading: (handler) => {
    const listener = (_event: unknown, reading: ControllerReading): void =>
      handler(reading);
    ipcRenderer.on('controller:reading', listener);
    return () => {
      ipcRenderer.removeListener('controller:reading', listener);
    };
  },
};

contextBridge.exposeInMainWorld('overlay', api);
