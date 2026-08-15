import { ipcMain, type BrowserWindow } from 'electron';
import type { Revision, TargetProfile } from '@irudd-le/protocol';
import type { EnrollmentState } from './enrollment-store';
import { loadCachedRevision, saveCachedRevision } from './revision-cache';
import { fetchChannelProfile, fetchCurrentRevision, openRevisionEvents } from './revision-client';

const ACTIVATION_BUDGET_MS = 5_000;
const RECONNECT_DELAY_MS = 2_000;

interface DeliveryContext {
  mailboxUrl: string;
  channel: string;
  secret: string;
  cacheKey: string;
}

interface StageResult {
  attemptId: string;
  revisionId: string;
  staged: boolean;
  error?: string;
}

interface ActivationResult {
  attemptId: string;
  revisionId: string;
  activated: boolean;
  error?: string;
}

/** Events are prompts; each connection starts with the durable revision. */
export class RevisionDelivery {
  private stopped = true;
  private generation = 0;
  private nextAttempt = 0;
  private readonly activeAttempts = new Set<string>();
  private controller: AbortController | null = null;
  private contextKey: string | null = null;

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
    if (this.stopped || !state?.channel) return;
    const context: DeliveryContext = {
      mailboxUrl: state.mailboxUrl,
      channel: state.channel,
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
    void this.connect(context, generation, this.controller.signal, cached?.channel === context.channel ? cached : null);
  }

  private async connect(
    context: DeliveryContext,
    generation: number,
    signal: AbortSignal,
    cached: Revision | null
  ): Promise<void> {
    if (cached) {
      try {
        await this.activate(cached, false, context.cacheKey, generation);
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
        await this.refresh(context, profile, signal, generation);
        await this.consumeEvents(events, context, profile, signal, generation);
      } catch (error: unknown) {
        await events?.body?.cancel().catch(() => undefined);
        if (signal.aborted || this.stopped || generation !== this.generation) return;
        this.report('mailbox delivery disconnected', error);
        await delay(RECONNECT_DELAY_MS, signal);
      }
    }
  }

  private async refresh(
    context: DeliveryContext,
    profile: TargetProfile,
    signal: AbortSignal,
    generation: number
  ): Promise<void> {
    try {
      const revision = await fetchCurrentRevision(context.mailboxUrl, context.channel, context.secret, signal);
      this.validateCandidate(revision, context.channel, profile);
      await this.activate(revision, true, context.cacheKey, generation);
    } catch (error: unknown) {
      if (isNoCurrentRevision(error)) return;
      throw error;
    }
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
          if (event.startsWith('event: revision\n')) await this.refresh(context, profile, signal, generation);
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
    // #33 owns immutable asset retrieval. Rejecting here preserves the last
    // useful display until every required asset can be staged and hashed.
    if (revision.assetIds.length > 0) throw new Error(`Candidate '${revision.id}' requires unavailable staged assets`);
  }

  private async activate(revision: Revision, persist: boolean, cacheKey: string, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) throw new Error(`Candidate '${revision.id}' was superseded before staging`);
    const startedAt = Date.now();
    const attemptId = `${generation}:${++this.nextAttempt}`;
    this.activeAttempts.add(attemptId);
    try {
      const staged = await this.awaitStage(attemptId, revision, startedAt + ACTIVATION_BUDGET_MS);
      if (!staged.staged) throw new Error(staged.error ?? `Candidate '${revision.id}' was rejected by the renderer`);
      if (!this.isCurrent(generation)) throw new Error(`Candidate '${revision.id}' was superseded before activation`);

      const result = await this.awaitCommit(attemptId, revision, startedAt + ACTIVATION_BUDGET_MS);
      if (!result.activated) throw new Error(result.error ?? `Candidate '${revision.id}' was rejected by the renderer`);
      if (!this.isCurrent(generation) || Date.now() - startedAt > ACTIVATION_BUDGET_MS) {
        throw new Error(`Candidate '${revision.id}' was superseded or exceeded its activation budget`);
      }
      if (persist) saveCachedRevision(this.userDataDir, cacheKey, revision);
    } finally {
      this.activeAttempts.delete(attemptId);
      this.sendDiscard(attemptId);
    }
  }

  private async awaitStage(attemptId: string, revision: Revision, deadlineAt: number): Promise<StageResult> {
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
