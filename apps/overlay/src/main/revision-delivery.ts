import { ipcMain, type BrowserWindow } from 'electron';
import { PROTOCOL_VERSION, type RenderStatus, type Revision, type TargetProfile } from '@irudd-le/protocol';
import type { EnrollmentState } from './enrollment-store';
import { loadCachedRevision, saveCachedRevision, type CachedRevision } from './revision-cache';
import { fetchChannelProfile, fetchCurrentRevision, fetchRevisionAssets, openRevisionEvents } from './revision-client';
import { reportRenderStatus } from './enrollment-client';

const ACTIVATION_BUDGET_MS = 5_000;
const RECONNECT_DELAY_MS = 2_000;

interface DeliveryContext {
  mailboxUrl: string;
  channel: string;
  targetId: string;
  secret: string;
  cacheKey: string;
}

interface StageResult {
  attemptId: string;
  revisionId: string;
  staged: boolean;
  error?: string;
  metrics?: RenderMetrics;
}

interface ActivationResult {
  attemptId: string;
  revisionId: string;
  activated: boolean;
  error?: string;
  metrics?: RenderMetrics;
}

interface RenderMetrics {
  width: number;
  height: number;
  scrollWidth: number;
  scrollHeight: number;
}

/** Events are prompts; each connection starts with the durable revision. */
export class RevisionDelivery {
  private stopped = true;
  private generation = 0;
  private nextAttempt = 0;
  private readonly activeAttempts = new Set<string>();
  private controller: AbortController | null = null;
  private contextKey: string | null = null;
  private currentRevisionId: string | null = null;
  private lastMetrics: RenderMetrics | null = null;
  private lastState: EnrollmentState | null = null;

  constructor(private readonly win: BrowserWindow, private readonly userDataDir: string) {}

  start(state: EnrollmentState | null): void {
    this.stopped = false;
    this.update(state);
  }

  stop(): void {
    this.discardActiveAttempts();
    this.stopped = true;
    this.generation += 1;
    this.contextKey = null;
    this.controller?.abort();
    this.controller = null;
  }

  update(state: EnrollmentState | null): void {
    this.lastState = state;
    if (this.stopped || !state?.channel) return;
    const context: DeliveryContext = {
      mailboxUrl: state.mailboxUrl,
      channel: state.channel,
      targetId: state.targetId,
      secret: state.secret,
      cacheKey: JSON.stringify({ mailboxUrl: state.mailboxUrl, targetId: state.targetId, channel: state.channel }),
    };
    const key = JSON.stringify(context);
    if (key === this.contextKey) return;
    this.discardActiveAttempts();
    this.contextKey = key;
    this.controller?.abort();
    this.controller = new AbortController();
    const generation = ++this.generation;

    const cached = loadCachedRevision(this.userDataDir, context.cacheKey);
    void this.connect(context, generation, this.controller.signal, cached?.revision.channel === context.channel ? cached : null);
  }

  /** A heartbeat observed a new profile, so restart delivery with its version. */
  refresh(): void {
    if (this.stopped || !this.lastState) return;
    this.contextKey = null;
    this.update(this.lastState);
  }

  private async connect(
    context: DeliveryContext,
    generation: number,
    signal: AbortSignal,
    cached: CachedRevision | null
  ): Promise<void> {
    if (cached) {
      try {
        await this.activate(cached.revision, false, context, { version: cached.revision.profileVersion, contentBox: { width: 1, height: 1 } } as TargetProfile, generation, cached.assets);
      } catch (error: unknown) {
        this.report('cached revision rejected', error);
      }
    }
    while (!this.stopped && generation === this.generation && !signal.aborted) {
      let events: Response | null = null;
      try {
        const profile = await fetchChannelProfile(context.mailboxUrl, context.channel, context.secret, signal);
        // Subscribe before the durable read. Any publication that lands
        // between these calls is buffered by the established SSE response.
        events = await openRevisionEvents(context.mailboxUrl, context.channel, context.secret, signal);
        await this.refreshRevision(context, profile, signal, generation);
        await this.consumeEvents(events, context, profile, signal, generation);
      } catch (error: unknown) {
        await events?.body?.cancel().catch(() => undefined);
        if (signal.aborted || this.stopped || generation !== this.generation) return;
        this.report('mailbox delivery disconnected', error);
        await delay(RECONNECT_DELAY_MS, signal);
      }
    }
  }

  private async refreshRevision(
    context: DeliveryContext,
    profile: TargetProfile,
    signal: AbortSignal,
    generation: number
  ): Promise<void> {
    let revision: Revision;
    try {
      revision = await fetchCurrentRevision(context.mailboxUrl, context.channel, context.secret, signal);
    } catch (error: unknown) {
      if (isNoCurrentRevision(error)) return;
      throw error;
    }
    try {
      this.validateCandidate(revision, context.channel, profile);
    } catch (error: unknown) {
      // Validation is part of activation: record the durable candidate even
      // when it never reaches the renderer, so an agent can distinguish it
      // from the revision still visible on the target.
      const startedAt = Date.now();
      await this.recordObservation(
        context,
        this.currentRevisionId,
        revision.id,
        profile.version,
        `${generation}:validation:${++this.nextAttempt}`,
        startedAt,
        this.lastMetrics ?? this.metricsFor(profile),
        'rejected',
        describeError(error)
      );
      throw error;
    }
    await this.activate(revision, true, context, profile, generation);
  }

  private async consumeEvents(
    response: Response,
    context: DeliveryContext,
    profile: TargetProfile,
    signal: AbortSignal,
    generation: number
  ): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (!signal.aborted) {
        const next = await reader.read();
        if (next.done) return;
        pending += decoder.decode(next.value, { stream: true });
        let boundary = pending.indexOf('\n\n');
        while (boundary >= 0) {
          const event = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (event.startsWith('event: revision\n')) await this.refreshRevision(context, profile, signal, generation);
          boundary = pending.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private validateCandidate(revision: Revision, channel: string, profile: TargetProfile): void {
    if (revision.channel !== channel) throw new Error(`Candidate '${revision.id}' belongs to another channel`);
    if (revision.profileVersion !== profile.version) {
      throw new Error(`Candidate '${revision.id}' targets profile ${revision.profileVersion}, not ${profile.version}`);
    }
  }

  private async activate(
    revision: Revision,
    persist: boolean,
    context: DeliveryContext,
    profile: TargetProfile,
    generation: number,
    cachedAssets?: CachedRevision['assets']
  ): Promise<void> {
    if (!this.isCurrent(generation)) throw new Error(`Candidate '${revision.id}' was superseded before staging`);
    const startedAt = Date.now();
    const attemptId = `${generation}:${++this.nextAttempt}`;
    let stagedMetrics: RenderMetrics | undefined;
    this.activeAttempts.add(attemptId);
    try {
      // Assets are fetched and verified in the authenticated main process,
      // never by the published iframe. Any failure stays inside this attempt,
      // leaving the current iframe untouched.
      const assets = cachedAssets ?? await fetchRevisionAssets(context.mailboxUrl, context.channel, context.secret, revision.assetIds);
      const staged = await this.awaitStage(attemptId, activationRevision(revision, assets), startedAt + ACTIVATION_BUDGET_MS);
      stagedMetrics = staged.metrics;
      if (!staged.staged) throw new Error(staged.error ?? `Candidate '${revision.id}' was rejected by the renderer`);
      if (!this.isCurrent(generation)) throw new Error(`Candidate '${revision.id}' was superseded before activation`);
      if (Date.now() - startedAt > ACTIVATION_BUDGET_MS) {
        throw new Error(`Candidate '${revision.id}' exceeded its activation budget before commit`);
      }

      const result = await this.awaitCommit(attemptId, revision, startedAt + ACTIVATION_BUDGET_MS);
      if (!result.activated) throw new Error(result.error ?? `Candidate '${revision.id}' was rejected by the renderer`);
      const metrics = result.metrics ?? staged.metrics ?? this.metricsFor(profile);
      this.currentRevisionId = revision.id;
      this.lastMetrics = metrics;
      await this.recordObservation(context, revision.id, revision.id, revision.profileVersion, attemptId, startedAt, metrics, 'active', null);
      if (persist) {
        try {
          saveCachedRevision(this.userDataDir, context.cacheKey, revision, assets);
        } catch (error: unknown) {
          this.report('could not cache activated revision', error);
        }
      }
    } catch (error: unknown) {
      await this.recordObservation(
        context,
        this.currentRevisionId,
        revision.id,
        profile.version,
        attemptId,
        startedAt,
        stagedMetrics ?? this.lastMetrics ?? this.metricsFor(profile),
        'rejected',
        describeError(error)
      );
      throw error;
    } finally {
      this.activeAttempts.delete(attemptId);
      this.sendDiscard(attemptId);
    }
  }

  private async awaitStage(attemptId: string, revision: RevisionActivation, deadlineAt: number): Promise<StageResult> {
    return this.awaitRendererResult('revision:stage-result', attemptId, revision.id, deadlineAt, isStageResult, () => {
      this.win.webContents.send('revision:stage', { attemptId, revision, deadlineAt });
    });
  }

  private async awaitCommit(attemptId: string, revision: Revision, deadlineAt: number): Promise<ActivationResult> {
    return this.awaitRendererResult('revision:commit-result', attemptId, revision.id, deadlineAt, isActivationResult, () => {
      this.win.webContents.send('revision:commit', attemptId);
    });
  }

  private async awaitRendererResult<T extends { attemptId: string; revisionId: string }>(
    eventName: 'revision:stage-result' | 'revision:commit-result',
    attemptId: string,
    revisionId: string,
    deadlineAt: number,
    isResult: (value: unknown) => value is T,
    send: () => void
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onResult = (event: Electron.IpcMainEvent, value: unknown): void => {
        if (event.sender !== this.win.webContents || !isResult(value) || value.attemptId !== attemptId || value.revisionId !== revisionId) return;
        cleanup();
        resolve(value);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Candidate '${revisionId}' did not activate within ${ACTIVATION_BUDGET_MS}ms`));
      }, Math.max(0, deadlineAt - Date.now()));
      const cleanup = (): void => {
        clearTimeout(timeout);
        ipcMain.removeListener(eventName, onResult);
      };
      ipcMain.on(eventName, onResult);
      if (this.win.isDestroyed()) {
        cleanup();
        reject(new Error('Overlay window is closed'));
        return;
      }
      send();
    });
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private discardActiveAttempts(): void {
    for (const attemptId of this.activeAttempts) this.sendDiscard(attemptId);
    this.activeAttempts.clear();
  }

  private sendDiscard(attemptId: string): void {
    if (!this.win.isDestroyed()) this.win.webContents.send('revision:discard', attemptId);
  }

  private report(message: string, error: unknown): void {
    // #24 owns durable external render-status reporting.
    console.warn(`[overlay] ${message}:`, error instanceof Error ? error.message : error);
  }

  private metricsFor(profile: TargetProfile): RenderMetrics {
    return {
      width: profile.contentBox.width,
      height: profile.contentBox.height,
      scrollWidth: profile.contentBox.width,
      scrollHeight: profile.contentBox.height,
    };
  }

  private async recordObservation(
    context: DeliveryContext,
    currentRevisionId: string | null,
    candidateRevisionId: string,
    profileVersion: number,
    attemptId: string,
    attemptStartedAt: number,
    metrics: RenderMetrics,
    activation: RenderStatus['activation'],
    failureReason: string | null
  ): Promise<void> {
    const status: RenderStatus = {
      protocolVersion: PROTOCOL_VERSION,
      targetId: context.targetId,
      attemptId,
      attemptStartedAt,
      profileVersion,
      currentRevisionId,
      candidateRevisionId,
      rendered: metrics,
      overflow: { horizontal: metrics.scrollWidth > metrics.width, vertical: metrics.scrollHeight > metrics.height },
      activation,
      failureReason,
    };
    try {
      await reportRenderStatus(context.mailboxUrl, context.targetId, context.secret, status);
    } catch (error: unknown) {
      this.report('could not report render observation', error);
    }
  }
}

interface RevisionActivation extends Revision {
  assetSources: Array<{ id: string; dataUrl: string }>;
}

function activationRevision(revision: Revision, assets: CachedRevision['assets']): RevisionActivation {
  if (assets.length !== revision.assetIds.length || assets.some((asset, index) => asset.id !== revision.assetIds[index])) {
    throw new Error(`Candidate '${revision.id}' does not have every required staged asset`);
  }
  return {
    ...revision,
    assetSources: assets.map((asset) => ({ id: asset.id, dataUrl: `data:${asset.contentType};base64,${asset.data.toString('base64')}` })),
  };
}

function isNoCurrentRevision(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'no_current_revision';
}

function isActivationResult(value: unknown): value is ActivationResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.attemptId === 'string' && typeof result.revisionId === 'string' && typeof result.activated === 'boolean' &&
    (result.error === undefined || typeof result.error === 'string');
}

function isStageResult(value: unknown): value is StageResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.attemptId === 'string' && typeof result.revisionId === 'string' && typeof result.staged === 'boolean' &&
    (result.error === undefined || typeof result.error === 'string');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown activation failure';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
