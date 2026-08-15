import type { BrowserWindow } from 'electron';
import { PROTOCOL_VERSION, targetProfileSchema, type TargetProfile } from '@irudd-le/protocol';
import { config } from './config';
import { clearEnrollment, loadEnrollment, saveEnrollment, type EnrollmentState } from './enrollment-store';
import { EnrollmentApiError, heartbeat, registerTarget } from './enrollment-client';
import { RevisionDelivery } from './revision-delivery';
import { clearCachedRevision } from './revision-cache';

const PROFILE_VERSION = 1;

/**
 * Owns the overlay's mailbox identity: registering as a pending target,
 * heartbeating until (and after) an admin pairs it, and persisting the
 * result so a restart preserves the assignment (issue #21's third
 * acceptance criterion) without re-enrolling. The renderer only ever sees
 * `EnrollmentInfo` -- the target secret never crosses the preload bridge.
 */
export class EnrollmentManager {
  private readonly win: BrowserWindow;
  private readonly userDataDir: string;
  private state: EnrollmentState | null;
  private pairingCode: string | null = null;
  private pairingCodeExpiresAt: number | null = null;
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly delivery: RevisionDelivery;

  constructor(win: BrowserWindow, userDataDir: string) {
    this.win = win;
    this.userDataDir = userDataDir;
    this.state = loadEnrollment(userDataDir);
    this.delivery = new RevisionDelivery(win, userDataDir);
  }

  /** Call once, after the window has a page loaded. Resumes heartbeating if already enrolled. */
  start(): void {
    this.delivery.start(this.state);
    if (this.state) this.startHeartbeat();
  }

  stop(): void {
    this.stopHeartbeat();
    this.delivery.stop();
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  info(): EnrollmentInfo {
    return {
      status: this.state === null ? 'unenrolled' : this.state.channel === null ? 'pending' : 'paired',
      mailboxUrl: this.state?.mailboxUrl ?? null,
      clientName: this.state?.clientName ?? null,
      pairingCode: this.pairingCode,
      pairingCodeExpiresAt: this.pairingCodeExpiresAt,
      channel: this.state?.channel ?? null,
      error: this.error,
    };
  }

  async enroll(input: { mailboxUrl: string; clientName: string }): Promise<EnrollmentInfo> {
    this.stop();
    try {
      const profile = await this.measureProfile();
      const registration = await registerTarget(input.mailboxUrl, input.clientName, profile);
      this.state = {
        mailboxUrl: input.mailboxUrl,
        clientName: input.clientName,
        targetId: registration.id,
        secret: registration.secret,
        channel: null,
      };
      saveEnrollment(this.userDataDir, this.state);
      this.pairingCode = registration.pairingCode;
      this.pairingCodeExpiresAt = registration.pairingCodeExpiresAt;
      this.error = null;
      this.delivery.start(this.state);
      this.startHeartbeat();
    } catch (error: unknown) {
      this.error = describeError(error);
    }
    this.broadcast();
    return this.info();
  }

  /** Clears local identity. A subsequent enroll() call is the "explicit re-enrollment" the issue requires for retargeting. */
  reEnroll(): EnrollmentInfo {
    this.stop();
    clearEnrollment(this.userDataDir);
    clearCachedRevision(this.userDataDir);
    this.state = null;
    this.pairingCode = null;
    this.pairingCodeExpiresAt = null;
    this.error = null;
    this.broadcast();
    return this.info();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    void this.heartbeatOnce();
    this.timer = setInterval(() => void this.heartbeatOnce(), config.enrollment.heartbeatIntervalMs);
  }

  private async heartbeatOnce(): Promise<void> {
    const current = this.state;
    if (!current) return;
    try {
      const profile = await this.measureProfile();
      const response = await heartbeat(current.mailboxUrl, current.targetId, current.secret, profile);
      this.error = null;
      if (response.channel !== current.channel) {
        this.state = { ...current, channel: response.channel };
        saveEnrollment(this.userDataDir, this.state);
        // Pairing consumes the code server-side; stop showing a stale one.
        if (response.channel !== null) {
          this.pairingCode = null;
          this.pairingCodeExpiresAt = null;
        }
        this.delivery.update(this.state);
      }
    } catch (error: unknown) {
      // A transient network hiccup or an expired/unknown target must never
      // crash the loop -- the next tick retries, matching UpdateManager's
      // "periodic checks never throw uncaught" convention.
      this.error = describeError(error);
    }
    this.broadcast();
  }

  private async measureProfile(): Promise<TargetProfile> {
    const measured = (await this.win.webContents.executeJavaScript(
      `(() => {
        const box = document.getElementById('content-box').getBoundingClientRect();
        return { width: box.width, height: box.height, devicePixelRatio: window.devicePixelRatio };
      })()`
    )) as { width: number; height: number; devicePixelRatio: number };

    const width = Math.max(1, Math.round(measured.width));
    const height = Math.max(1, Math.round(measured.height));
    const devicePixelRatio = measured.devicePixelRatio > 0 ? measured.devicePixelRatio : 1;

    return targetProfileSchema.parse({
      version: PROFILE_VERSION,
      contentBox: { width, height },
      devicePixelRatio,
      screenshot: { width: Math.round(width * devicePixelRatio), height: Math.round(height * devicePixelRatio) },
      preferredIconSize: config.enrollment.preferredIconSize,
      minimumTextSize: config.enrollment.minimumTextSize,
      background: { opaque: false },
      features: config.enrollment.features,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  private broadcast(): void {
    if (this.win.isDestroyed()) return;
    this.win.webContents.send('enrollment:changed', this.info());
  }
}

function describeError(error: unknown): string {
  if (error instanceof EnrollmentApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}
