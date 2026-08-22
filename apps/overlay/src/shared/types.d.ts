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
 * `unenrolled`: no local identity yet, or it was just cleared by re-enroll.
 * `pending`: registered with a mailbox, waiting for an admin to pair it.
 * `paired`: a channel is assigned; this is what "restart preserves the
 * assignment" means in practice -- loaded straight from local state.
 */
type EnrollmentStatus = 'unenrolled' | 'pending' | 'paired';

/** What the renderer's setup screen needs; never carries the target secret. */
interface EnrollmentInfo {
  status: EnrollmentStatus;
  mailboxUrl: string | null;
  clientName: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAt: number | null;
  channel: string | null;
  /** The last enroll/heartbeat failure, if any, shown as-is to the operator. */
  error: string | null;
}

interface EnrollmentApi {
  getState(): Promise<EnrollmentInfo | null>;
  enroll(input: { mailboxUrl: string; clientName: string }): Promise<EnrollmentInfo | null>;
  /** Clears local identity so a fresh enrollment can retarget this overlay. */
  reEnroll(): Promise<EnrollmentInfo | null>;
  /** Returns an unsubscribe function. */
  onChanged(handler: (info: EnrollmentInfo) => void): () => void;
}

interface RevisionActivation {
  protocolVersion: number;
  id: string;
  channel: string;
  profileVersion: number;
  html: string;
  assetIds: string[];
  /** Verified main-process bytes, represented for the opaque iframe only. */
  assetSources: Array<{ id: string; dataUrl: string }>;
}

interface RevisionActivationCommand {
  attemptId: string;
  revision: RevisionActivation;
  deadlineAt: number;
}

interface RevisionStageResult {
  attemptId: string;
  revisionId: string;
  staged: boolean;
  error?: string;
  metrics?: RenderMetrics;
}

interface RenderMetrics {
  width: number;
  height: number;
  scrollWidth: number;
  scrollHeight: number;
}

interface RevisionCommitResult {
  attemptId: string;
  revisionId: string;
  activated: boolean;
  error?: string;
  metrics?: RenderMetrics;
}

interface RevisionApi {
  onStage(handler: (command: RevisionActivationCommand) => void): () => void;
  onCommit(handler: (attemptId: string) => void): () => void;
  onDiscard(handler: (attemptId: string) => void): () => void;
  completeStage(result: RevisionStageResult): void;
  completeCommit(result: RevisionCommitResult): void;
}

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
  resize: {
    begin(): Promise<boolean>;
    update(delta: { width: number; height: number }): void;
    end(): void;
  };
  quit(): void;
  /** Returns an unsubscribe function. */
  onModeChanged(handler: (state: OverlayState) => void): () => void;
  /** Returns an unsubscribe function. */
  onUpdateStatusChanged(handler: (status: UpdateStatus) => void): () => void;

  enrollment: EnrollmentApi;
  revisions: RevisionApi;
}

interface Window {
  overlay: OverlayApi;
}
