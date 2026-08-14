/**
 * The contract between main, preload and renderer.
 *
 * Ambient on purpose (a .d.ts with no imports/exports): both tsconfigs pick it
 * up, nothing is emitted, and neither side can drift from the other without
 * `pnpm typecheck` complaining.
 *
 * When v2/v3 land, their API objects get declared here too -- e.g.
 * `ollama: OllamaApi` and `capture: CaptureApi` alongside `overlay`.
 */

interface OverlayShortcuts {
  toggleInteractive: string;
  toggleVisibility: string;
  quit: string;
}

/** The only mutable state v1 has. */
interface OverlayState {
  /** false = mouse events fall through to the game. */
  interactive: boolean;
}

/** The updater is deliberately informational: couch distance leaves no action. */
type UpdateStatus = 'idle' | 'downloading';

/** State plus the read-only facts the UI wants at boot. */
interface OverlayInfo extends OverlayState {
  protocolVersion: number;
  shortcuts: OverlayShortcuts;
  platform: string;
  version: string;
  isDev: boolean;
  updateStatus: UpdateStatus;
}

/** Exactly what `window.overlay` offers. Mirrored in src/preload/index.ts. */
interface OverlayApi {
  getState(): Promise<OverlayInfo | null>;
  setInteractive(interactive: boolean): Promise<OverlayState | null>;
  toggleInteractive(): Promise<OverlayState | null>;
  quit(): void;
  /** Returns an unsubscribe function. */
  onModeChanged(handler: (state: OverlayState) => void): () => void;
  /** Returns an unsubscribe function. */
  onUpdateStatusChanged(handler: (status: UpdateStatus) => void): () => void;
}

interface Window {
  overlay: OverlayApi;
}
