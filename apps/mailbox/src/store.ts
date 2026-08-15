import { DatabaseSync } from 'node:sqlite';
import { PROTOCOL_VERSION, type Channel, type RenderStatus, type Revision, type TargetProfile, type TokenKind } from '@irudd-le/protocol';
import { runMigrations } from './migrations';

export interface TokenRecord {
  id: string;
  kind: TokenKind;
  channel: string | null;
  label: string;
  createdAt: number;
  revokedAt: number | null;
}

interface NewToken extends TokenRecord {
  secretHash: string;
}

export interface TargetRecord {
  id: string;
  clientName: string;
  profile: TargetProfile;
  channel: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAt: number | null;
  createdAt: number;
  lastSeenAt: number;
  capabilities: string[];
  clientVersion: string;
  profileChangedAt: number | null;
  republishRecommended: boolean;
}

interface NewTarget extends TargetRecord {
  secretHash: string;
}

export type PairTargetResult = 'paired' | 'target_not_found' | 'target_already_paired' | 'channel_exists';
export type RenderStatusResult = 'recorded' | 'stale_profile' | 'stale_observation' | 'unknown_revision';

export interface StoredRenderStatus extends RenderStatus {
  observedAt: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    runMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  createChannel(channel: Channel): void {
    this.db
      .prepare('INSERT INTO channels (id, name, protocolVersion, createdAt) VALUES (?, ?, ?, ?)')
      .run(channel.id, channel.name, channel.protocolVersion, Date.now());
  }

  getChannel(id: string): Channel | undefined {
    const row = this.db
      .prepare('SELECT id, name, protocolVersion FROM channels WHERE id = ?')
      .get(id) as { id: string; name: string; protocolVersion: number } | undefined;
    if (!row) return undefined;
    return { protocolVersion: PROTOCOL_VERSION, id: row.id, name: row.name };
  }

  publishRevision(
    channel: string,
    revision: Revision,
    expectedCurrentRevisionId?: string | null
  ): 'published' | 'current_revision_conflict' {
    const htmlBlob = Buffer.from(revision.html, 'utf8');
    const assetIdsJson = JSON.stringify(revision.assetIds);
    this.db.exec('BEGIN');
    try {
      if (expectedCurrentRevisionId !== undefined) {
        const current = this.db
          .prepare('SELECT revision_id AS revisionId FROM channel_current_revisions WHERE channel = ?')
          .get(channel) as { revisionId: string } | undefined;
        if ((current?.revisionId ?? null) !== expectedCurrentRevisionId) {
          this.db.exec('ROLLBACK');
          return 'current_revision_conflict';
        }
      }
      this.db
        .prepare(
          'INSERT INTO revisions (channel, id, protocolVersion, profileVersion, html, asset_ids, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          channel,
          revision.id,
          revision.protocolVersion,
          revision.profileVersion,
          htmlBlob,
          assetIdsJson,
          Date.now()
        );
      this.db
        .prepare(
          'INSERT INTO channel_current_revisions (channel, revision_id, updatedAt) VALUES (?, ?, ?) ON CONFLICT (channel) DO UPDATE SET revision_id = excluded.revision_id, updatedAt = excluded.updatedAt'
      )
        .run(channel, revision.id, Date.now());
      this.db.exec('COMMIT');
      return 'published';
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getCurrentRevision(channel: string): Revision | undefined {
    const row = this.db
      .prepare(
        `SELECT r.id, r.profileVersion, r.html, r.asset_ids AS assetIds
           FROM revisions r
           JOIN channel_current_revisions c ON c.revision_id = r.id AND c.channel = r.channel
          WHERE c.channel = ?`
      )
      .get(channel) as
      | {
          id: string;
          profileVersion: number;
          html: Uint8Array;
          assetIds: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      protocolVersion: PROTOCOL_VERSION,
      id: row.id,
      channel,
      profileVersion: row.profileVersion,
      html: Buffer.from(row.html).toString('utf8'),
      assetIds: JSON.parse(row.assetIds) as string[],
    };
  }

  createToken(token: NewToken): void {
    this.db
      .prepare(
        'INSERT INTO tokens (id, kind, channel, label, secret_hash, createdAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(token.id, token.kind, token.channel, token.label, token.secretHash, token.createdAt, token.revokedAt);
  }

  listTokens(): TokenRecord[] {
    const rows = this.db
      .prepare('SELECT id, kind, channel, label, createdAt, revokedAt FROM tokens ORDER BY createdAt ASC')
      .all() as unknown as TokenRow[];
    return rows.map(toTokenRecord);
  }

  findActiveTokenByHash(secretHash: string): TokenRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, kind, channel, label, createdAt, revokedAt FROM tokens WHERE secret_hash = ? AND revokedAt IS NULL'
      )
      .get(secretHash) as TokenRow | undefined;
    if (!row) return undefined;
    return toTokenRecord(row);
  }

  getToken(id: string): TokenRecord | undefined {
    const row = this.db
      .prepare('SELECT id, kind, channel, label, createdAt, revokedAt FROM tokens WHERE id = ?')
      .get(id) as TokenRow | undefined;
    if (!row) return undefined;
    return toTokenRecord(row);
  }

  /** Soft revoke: the row (and its label) is kept for attribution, never deleted. */
  revokeToken(id: string): 'not_found' | 'revoked' {
    const row = this.db.prepare('SELECT revokedAt FROM tokens WHERE id = ?').get(id) as { revokedAt: number | null } | undefined;
    if (!row) return 'not_found';
    if (row.revokedAt === null) {
      this.db.prepare('UPDATE tokens SET revokedAt = ? WHERE id = ?').run(Date.now(), id);
    }
    return 'revoked';
  }

  hasAnyTokenOfKind(kind: TokenKind): boolean {
    const row = this.db.prepare('SELECT 1 AS hit FROM tokens WHERE kind = ? LIMIT 1').get(kind);
    return row !== undefined;
  }

  countActiveTokensOfKind(kind: TokenKind): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE kind = ? AND revokedAt IS NULL').get(kind) as { n: number };
    return row.n;
  }

  createTarget(target: NewTarget): void {
    this.db
      .prepare(
        `INSERT INTO targets
           (id, secret_hash, client_name, profile, channel, pairing_code, pairing_code_expires_at, createdAt, lastSeenAt,
            capabilities, client_version, profile_changed_at, republish_recommended)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        target.id,
        target.secretHash,
        target.clientName,
        JSON.stringify(target.profile),
        target.channel,
        target.pairingCode,
        target.pairingCodeExpiresAt,
        target.createdAt,
        target.lastSeenAt,
        JSON.stringify(target.capabilities),
        target.clientVersion,
        target.profileChangedAt,
        Number(target.republishRecommended)
      );
  }

  getTarget(id: string): TargetRecord | undefined {
    const row = this.db.prepare(SELECT_TARGET).get(id) as TargetRow | undefined;
    if (!row) return undefined;
    return toTargetRecord(row);
  }

  findTargetBySecretHash(secretHash: string): TargetRecord | undefined {
    const row = this.db
      .prepare(`${SELECT_TARGET_BY} secret_hash = ?`)
      .get(secretHash) as TargetRow | undefined;
    if (!row) return undefined;
    return toTargetRecord(row);
  }

  /**
   * The mailbox owns profile versions. A target may send a resized profile
   * after restart, so accepting a client-owned counter would let it move
   * backwards; instead, materially different measurements advance the
   * durable version here.
   */
  touchTargetHeartbeat(
    id: string,
    profile: TargetProfile,
    capabilities: string[],
    clientVersion: string
  ): { profile: TargetProfile; profileChanged: boolean; republishRecommended: boolean } {
    const target = this.getTarget(id);
    if (!target) throw new Error(`Target '${id}' disappeared while heartbeating`);
    const now = Date.now();
    const profileChanged = !sameProfileMeasurement(target.profile, profile);
    const currentProfile = profileChanged
      ? { ...profile, version: target.profile.version + 1 }
      : target.profile;
    const republishRecommended = profileChanged && target.channel !== null
      ? true
      : target.republishRecommended;

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE targets
              SET profile = ?, lastSeenAt = ?, capabilities = ?, client_version = ?,
                  profile_changed_at = ?, republish_recommended = ?
            WHERE id = ?`
        )
        .run(
          JSON.stringify(currentProfile),
          now,
          JSON.stringify(capabilities),
          clientVersion,
          profileChanged ? now : target.profileChangedAt,
          Number(republishRecommended),
          id
        );
      if (profileChanged && target.channel !== null) {
        this.db
          .prepare('UPDATE channel_profiles SET profile = ?, updatedAt = ? WHERE channel = ?')
          .run(JSON.stringify(currentProfile), now, target.channel);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { profile: currentProfile, profileChanged, republishRecommended };
  }

  getTargetByChannel(channel: string): TargetRecord | undefined {
    const row = this.db.prepare(`${SELECT_TARGET_BY} channel = ?`).get(channel) as TargetRow | undefined;
    return row ? toTargetRecord(row) : undefined;
  }

  recordRenderStatus(status: RenderStatus): RenderStatusResult {
    const target = this.getTarget(status.targetId);
    if (!target || target.channel === null) return 'stale_profile';
    if (target.profile.version !== status.profileVersion) return 'stale_profile';
    if (!this.revisionBelongsToChannel(target.channel, status.candidateRevisionId) || !this.revisionBelongsToChannel(target.channel, status.currentRevisionId)) {
      return 'unknown_revision';
    }
    const previous = this.db
      .prepare('SELECT attempt_started_at AS attemptStartedAt FROM render_statuses WHERE target_id = ?')
      .get(status.targetId) as { attemptStartedAt: number } | undefined;
    if (previous && previous.attemptStartedAt > status.attemptStartedAt) return 'stale_observation';

    const observedAt = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO render_statuses
             (target_id, attempt_id, attempt_started_at, profile_version, current_revision_id, candidate_revision_id,
              rendered, overflow, activation, failure_reason, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(target_id) DO UPDATE SET
             attempt_id = excluded.attempt_id, attempt_started_at = excluded.attempt_started_at,
             profile_version = excluded.profile_version, current_revision_id = excluded.current_revision_id,
             candidate_revision_id = excluded.candidate_revision_id, rendered = excluded.rendered,
             overflow = excluded.overflow, activation = excluded.activation, failure_reason = excluded.failure_reason,
             observed_at = excluded.observed_at`
        )
        .run(
          status.targetId, status.attemptId, status.attemptStartedAt, status.profileVersion,
          status.currentRevisionId, status.candidateRevisionId, JSON.stringify(status.rendered), JSON.stringify(status.overflow),
          status.activation, status.failureReason, observedAt
        );
      if (status.activation === 'active') {
        this.db.prepare('UPDATE targets SET republish_recommended = 0 WHERE id = ?').run(status.targetId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return 'recorded';
  }

  getRenderStatus(targetId: string): StoredRenderStatus | undefined {
    const row = this.db
      .prepare(
        `SELECT target_id AS targetId, attempt_id AS attemptId, attempt_started_at AS attemptStartedAt,
                profile_version AS profileVersion, current_revision_id AS currentRevisionId,
                candidate_revision_id AS candidateRevisionId, rendered, overflow, activation,
                failure_reason AS failureReason, observed_at AS observedAt
           FROM render_statuses WHERE target_id = ?`
      )
      .get(targetId) as RenderStatusRow | undefined;
    if (!row) return undefined;
    return {
      protocolVersion: PROTOCOL_VERSION,
      targetId: row.targetId,
      attemptId: row.attemptId,
      attemptStartedAt: row.attemptStartedAt,
      profileVersion: row.profileVersion,
      currentRevisionId: row.currentRevisionId,
      candidateRevisionId: row.candidateRevisionId,
      rendered: JSON.parse(row.rendered) as RenderStatus['rendered'],
      overflow: JSON.parse(row.overflow) as RenderStatus['overflow'],
      activation: row.activation as RenderStatus['activation'],
      failureReason: row.failureReason,
      observedAt: row.observedAt,
    };
  }

  private revisionBelongsToChannel(channel: string, revisionId: string | null): boolean {
    if (revisionId === null) return true;
    return this.db.prepare('SELECT 1 AS hit FROM revisions WHERE channel = ? AND id = ?').get(channel, revisionId) !== undefined;
  }

  listPendingTargets(): TargetRecord[] {
    const rows = this.db
      .prepare(`${SELECT_TARGET_BY} channel IS NULL ORDER BY createdAt ASC`)
      .all() as unknown as TargetRow[];
    return rows.map(toTargetRecord);
  }

  /**
   * Pairing always creates a brand-new channel from the target's current
   * profile, atomically with assigning it to the target. The profile is
   * read from `targets` inside this same transaction (not passed in by the
   * caller) so the frozen `channel_profiles` copy is safe by construction
   * rather than by the caller happening not to await anything in between.
   * `targets.channel` is UNIQUE, so a concurrent second pairing of the same
   * target loses this transaction's rollback rather than silently
   * double-assigning.
   */
  pairTarget(targetId: string, channel: Channel): PairTargetResult {
    this.db.exec('BEGIN');
    try {
      const target = this.db.prepare('SELECT channel, profile FROM targets WHERE id = ?').get(targetId) as
        | { channel: string | null; profile: string }
        | undefined;
      if (!target) {
        this.db.exec('ROLLBACK');
        return 'target_not_found';
      }
      if (target.channel !== null) {
        this.db.exec('ROLLBACK');
        return 'target_already_paired';
      }
      if (this.db.prepare('SELECT 1 AS hit FROM channels WHERE id = ?').get(channel.id)) {
        this.db.exec('ROLLBACK');
        return 'channel_exists';
      }
      this.db
        .prepare('INSERT INTO channels (id, name, protocolVersion, createdAt) VALUES (?, ?, ?, ?)')
        .run(channel.id, channel.name, channel.protocolVersion, Date.now());
      this.db
        .prepare('INSERT INTO channel_profiles (channel, profile, updatedAt) VALUES (?, ?, ?)')
        .run(channel.id, target.profile, Date.now());
      this.db
        .prepare('UPDATE targets SET channel = ?, pairing_code = NULL, pairing_code_expires_at = NULL WHERE id = ?')
        .run(channel.id, targetId);
      this.db.exec('COMMIT');
      return 'paired';
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getChannelProfile(channel: string): TargetProfile | undefined {
    const row = this.db.prepare('SELECT profile FROM channel_profiles WHERE channel = ?').get(channel) as
      | { profile: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.profile) as TargetProfile;
  }
}

interface TokenRow {
  id: string;
  kind: string;
  channel: string | null;
  label: string;
  createdAt: number;
  revokedAt: number | null;
}

function toTokenRecord(row: TokenRow): TokenRecord {
  return {
    id: row.id,
    kind: row.kind as TokenKind,
    channel: row.channel,
    label: row.label,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

interface TargetRow {
  id: string;
  clientName: string;
  profile: string;
  channel: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAt: number | null;
  createdAt: number;
  lastSeenAt: number;
  capabilities: string;
  clientVersion: string;
  profileChangedAt: number | null;
  republishRecommended: number;
}

const SELECT_TARGET = `
  SELECT id, client_name AS clientName, profile, channel,
         pairing_code AS pairingCode, pairing_code_expires_at AS pairingCodeExpiresAt,
         createdAt, lastSeenAt, capabilities, client_version AS clientVersion,
         profile_changed_at AS profileChangedAt, republish_recommended AS republishRecommended
    FROM targets
   WHERE id = ?`;

const SELECT_TARGET_BY = `
  SELECT id, client_name AS clientName, profile, channel,
         pairing_code AS pairingCode, pairing_code_expires_at AS pairingCodeExpiresAt,
         createdAt, lastSeenAt, capabilities, client_version AS clientVersion,
         profile_changed_at AS profileChangedAt, republish_recommended AS republishRecommended
    FROM targets
   WHERE `;

function toTargetRecord(row: TargetRow): TargetRecord {
  return {
    id: row.id,
    clientName: row.clientName,
    profile: JSON.parse(row.profile) as TargetProfile,
    channel: row.channel,
    pairingCode: row.pairingCode,
    pairingCodeExpiresAt: row.pairingCodeExpiresAt,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    capabilities: JSON.parse(row.capabilities) as string[],
    clientVersion: row.clientVersion,
    profileChangedAt: row.profileChangedAt,
    republishRecommended: Boolean(row.republishRecommended),
  };
}

interface RenderStatusRow {
  targetId: string;
  attemptId: string;
  attemptStartedAt: number;
  profileVersion: number;
  currentRevisionId: string | null;
  candidateRevisionId: string | null;
  rendered: string;
  overflow: string;
  activation: string;
  failureReason: string | null;
  observedAt: number;
}

function sameProfileMeasurement(current: TargetProfile, reported: TargetProfile): boolean {
  const { version: _currentVersion, ...currentMeasurement } = current;
  const { version: _reportedVersion, ...reportedMeasurement } = reported;
  return JSON.stringify(currentMeasurement) === JSON.stringify(reportedMeasurement);
}
