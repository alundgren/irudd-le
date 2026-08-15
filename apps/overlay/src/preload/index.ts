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

  enrollment: {
    getState: () => ipcRenderer.invoke('enrollment:get-state'),

    enroll: (input) => ipcRenderer.invoke('enrollment:enroll', input),

    reEnroll: () => ipcRenderer.invoke('enrollment:re-enroll'),

    onChanged: (handler) => {
      const listener = (_event: unknown, info: EnrollmentInfo): void => handler(info);
      ipcRenderer.on('enrollment:changed', listener);
      return () => {
        ipcRenderer.removeListener('enrollment:changed', listener);
      };
    },
  },

  revisions: {
    onStage: (handler) => {
      const listener = (_event: unknown, command: RevisionActivationCommand): void => handler(command);
      ipcRenderer.on('revision:stage', listener);
      return () => ipcRenderer.removeListener('revision:stage', listener);
    },
    onCommit: (handler) => {
      const listener = (_event: unknown, attemptId: string): void => handler(attemptId);
      ipcRenderer.on('revision:commit', listener);
      return () => ipcRenderer.removeListener('revision:commit', listener);
    },
    onDiscard: (handler) => {
      const listener = (_event: unknown, attemptId: string): void => handler(attemptId);
      ipcRenderer.on('revision:discard', listener);
      return () => ipcRenderer.removeListener('revision:discard', listener);
    },
    completeStage: (result) => ipcRenderer.send('revision:stage-result', result),
    completeCommit: (result) => ipcRenderer.send('revision:commit-result', result),
  },
};

contextBridge.exposeInMainWorld('overlay', api);
