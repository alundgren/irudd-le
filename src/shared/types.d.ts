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

/**
 * Whether the Windows GameInput native addon (issue #18) is backing
 * controller readings. 'unsupported' off Windows, 'unavailable' when the
 * addon has not been compiled yet or failed to load, 'active' once polling.
 */
type ControllerBridgeStatus = 'unsupported' | 'unavailable' | 'active';

/**
 * A single normalized controller snapshot, pushed from the main process at
 * ~30-60 Hz. Read-only observation, not input interception -- see
 * docs/research/xbox-controller-overlay-feasibility.md.
 */
interface ControllerReading {
  connected: boolean;
  dpadUp: boolean;
  dpadDown: boolean;
  dpadLeft: boolean;
  dpadRight: boolean;
  aPressed: boolean;
  /** -1..1 */
  leftStickX: number;
  /** -1..1 */
  leftStickY: number;
}

/** State plus the read-only facts the UI wants at boot. */
interface OverlayInfo extends OverlayState {
  shortcuts: OverlayShortcuts;
  platform: string;
  version: string;
  isDev: boolean;
  updateStatus: UpdateStatus;
  controllerBridge: ControllerBridgeStatus;
}

/** Exactly what `window.overlay` offers. Mirrored in src/preload/index.ts. */
interface OverlayApi {
  getState(): Promise<OverlayInfo | null>;
  setInteractive(interactive: boolean): Promise<OverlayState | null>;
  toggleInteractive(): Promise<OverlayState | null>;
  quit(): void;
  /**
   * Nudges the window by a pixel delta without focusing it. Fire-and-forget;
   * used by the controller move-mode chord (issue #18) to drag the overlay
   * from a gamepad left stick.
   */
  moveBy(dx: number, dy: number): void;
  /** Returns an unsubscribe function. */
  onModeChanged(handler: (state: OverlayState) => void): () => void;
  /** Returns an unsubscribe function. */
  onUpdateStatusChanged(handler: (status: UpdateStatus) => void): () => void;
  /** Returns an unsubscribe function. Fires only when controllerBridge is 'active'. */
  onControllerReading(handler: (reading: ControllerReading) => void): () => void;
}

interface Window {
  overlay: OverlayApi;
}
