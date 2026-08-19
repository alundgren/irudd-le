import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  PROTOCOL_VERSION,
  type AssetContentType,
  type Channel,
  type RenderStatus,
  type Revision,
  type RevisionDetail,
  type RevisionSummary,
  type TargetProfile,
  type TokenKind,
} from '@irudd-le/protocol';
import { runMigrations } from './migrations';

/** How many of a channel's most recent revisions retention keeps. */
export const REVISION_RETENTION_LIMIT = 20;

/** Grace period before a blob with no retained revision references is reclaimed. */
const ASSET_RETENTION_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

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
    return { protocolVersion: row.protocolVersion as Channel['protocolVersion'], id: row.id, name: row.name };
  }

  publishRevision(
    channel: string,
    revision: Revision,
    publishedBy: string | null,
    expectedCurrentRevisionId?: string | null
  ): 'published' | 'current_revision_conflict' {
    this.db.exec('BEGIN');
    try {
      if (expectedCurrentRevisionId !== undefined) {
        if (this.getCurrentRevisionId(channel) !== expectedCurrentRevisionId) {
          this.db.exec('ROLLBACK');
          return 'current_revision_conflict';
        }
      }
      this.insertRevision(channel, revision, publishedBy, null, hashHtml(revision.html));
      this.repointCurrent(channel, revision.id);
      this.sweepRetention(channel);
      this.db.exec('COMMIT');
      return 'published';
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Creates a brand-new current revision by copying an older retained
   * artifact's content, so the artifact being rolled back to is never
   * mutated and the rollback itself is a fresh, audit-visible history event.
   */
  rollbackRevision(
    channel: string,
    sourceRevisionId: string,
    newRevisionId: string,
    rolledBackBy: string | null,
    expectedCurrentRevisionId?: string | null
  ): 'rolled_back' | 'current_revision_conflict' | 'source_not_found' {
    this.db.exec('BEGIN');
    try {
      if (expectedCurrentRevisionId !== undefined) {
        if (this.getCurrentRevisionId(channel) !== expectedCurrentRevisionId) {
          this.db.exec('ROLLBACK');
          return 'current_revision_conflict';
        }
      }
      const source = this.db
        .prepare(
          `SELECT protocolVersion, profileVersion, html, asset_ids AS assetIds, title, description, content_hash AS contentHash
             FROM revisions WHERE channel = ? AND id = ?`
        )
        .get(channel, sourceRevisionId) as SourceRevisionRow | undefined;
      if (!source) {
        this.db.exec('ROLLBACK');
        return 'source_not_found';
      }
      const revision: Revision = {
        id: newRevisionId,
        channel,
        protocolVersion: source.protocolVersion as Revision['protocolVersion'],
        profileVersion: source.profileVersion,
        html: Buffer.from(source.html).toString('utf8'),
        assetIds: JSON.parse(source.assetIds) as string[],
        title: source.title,
        description: source.description,
      };
      // source.contentHash is null only for a revision published before v5
      // introduced hashing; the content being copied is identical either way,
      // so recomputing keeps every revision this code path creates hashed.
      this.insertRevision(channel, revision, rolledBackBy, sourceRevisionId, source.contentHash ?? hashHtml(revision.html));
      this.repointCurrent(channel, newRevisionId);
      this.sweepRetention(channel);
      this.db.exec('COMMIT');
      return 'rolled_back';
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getCurrentRevision(channel: string): Revision | undefined {
    const row = this.db
      .prepare(
        `SELECT r.id, r.protocolVersion, r.profileVersion, r.html, r.asset_ids AS assetIds, r.title, r.description
           FROM revisions r
           JOIN channel_current_revisions c ON c.revision_id = r.id AND c.channel = r.channel
          WHERE c.channel = ?`
      )
      .get(channel) as
      | {
          id: string;
          protocolVersion: number;
          profileVersion: number;
          html: Uint8Array;
          assetIds: string;
          title: string;
          description: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      // The revision's own recorded protocol version, not the server's
      // current constant -- see toRevisionSummary for the same distinction.
      protocolVersion: row.protocolVersion as Revision['protocolVersion'],
      id: row.id,
      channel,
      profileVersion: row.profileVersion,
      html: Buffer.from(row.html).toString('utf8'),
      assetIds: JSON.parse(row.assetIds) as string[],
      title: row.title,
      description: row.description,
    };
  }

  listRevisions(channel: string): RevisionSummary[] {
    const currentId = this.getCurrentRevisionId(channel);
    const rows = this.db
      .prepare(`${SELECT_REVISION_SUMMARY} WHERE r.channel = ? ORDER BY r.createdAt DESC, r.rowid DESC`)
      .all(channel) as unknown as RevisionSummaryRow[];
    return rows.map((row) => toRevisionSummary(channel, row, currentId));
  }

  getRevisionDetail(channel: string, id: string): RevisionDetail | undefined {
    const currentId = this.getCurrentRevisionId(channel);
    const row = this.db
      .prepare(`SELECT ${REVISION_SUMMARY_COLUMNS}, r.html AS html${REVISION_SUMMARY_FROM} WHERE r.channel = ? AND r.id = ?`)
      .get(channel, id) as (RevisionSummaryRow & { html: Uint8Array }) | undefined;
    if (!row) return undefined;
    return { ...toRevisionSummary(channel, row, currentId), html: Buffer.from(row.html).toString('utf8') };
  }

  private getCurrentRevisionId(channel: string): string | null {
    const row = this.db
      .prepare('SELECT revision_id AS revisionId FROM channel_current_revisions WHERE channel = ?')
      .get(channel) as { revisionId: string } | undefined;
    return row?.revisionId ?? null;
  }

  private repointCurrent(channel: string, revisionId: string): void {
    this.db
      .prepare(
        'INSERT INTO channel_current_revisions (channel, revision_id, updatedAt) VALUES (?, ?, ?) ON CONFLICT (channel) DO UPDATE SET revision_id = excluded.revision_id, updatedAt = excluded.updatedAt'
      )
      .run(channel, revisionId, Date.now());
  }

  private insertRevision(
    channel: string,
    revision: Revision,
    publishedBy: string | null,
    rolledBackFrom: string | null,
    contentHash: string | null
  ): void {
    this.db
      .prepare(
        `INSERT INTO revisions
           (channel, id, protocolVersion, profileVersion, html, asset_ids, title, description, content_hash, published_by, rolled_back_from, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        channel,
        revision.id,
        revision.protocolVersion,
        revision.profileVersion,
        Buffer.from(revision.html, 'utf8'),
        JSON.stringify(revision.assetIds),
        revision.title,
        revision.description,
        contentHash,
        publishedBy,
        rolledBackFrom,
        Date.now()
      );
  }

  /**
   * Keeps the latest `REVISION_RETENTION_LIMIT` revisions per channel by
   * creation time (rowid insertion order breaks ties within the same
   * millisecond). The current revision is always excluded from deletion
   * regardless of its rank: the composite FK from `channel_current_revisions`
   * added in migration v5 means a sweep that evicted it would fail loudly
   * with a constraint error rather than dangle the pointer, but this makes
   * that invariant explicit rather than incidental.
   */
  private sweepRetention(channel: string, keep = REVISION_RETENTION_LIMIT): void {
    const currentId = this.getCurrentRevisionId(channel);
    this.db
      .prepare(
        `DELETE FROM revisions
          WHERE channel = ?
            AND id IS NOT ?
            AND rowid NOT IN (
              SELECT rowid FROM revisions WHERE channel = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?
            )`
      )
      .run(channel, currentId, channel, keep);
    this.sweepUnreferencedAssets();
  }

  /**
   * Reclaims only blobs that have had no reference in any retained revision
   * for the full grace period. Asset ids live in revision JSON manifests, so
   * this deliberately checks the complete retained-revision set rather than
   * just the channel whose retention sweep happened to run.
   */
  private sweepUnreferencedAssets(): void {
    const now = Date.now();
    const cutoff = now - ASSET_RETENTION_PERIOD_MS;

    this.db
      .prepare(
        `UPDATE assets
            SET unreferenced_at = NULL
          WHERE unreferenced_at IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM revisions r, json_each(r.asset_ids) asset_id
               WHERE asset_id.value = assets.id
            )`
      )
      .run();
    this.db
      .prepare(
        `UPDATE assets
            SET unreferenced_at = ?
          WHERE unreferenced_at IS NULL
            AND NOT EXISTS (
              SELECT 1
                FROM revisions r, json_each(r.asset_ids) asset_id
               WHERE asset_id.value = assets.id
            )`
      )
      .run(now);

    // channel_assets intentionally has no delete cascade: deleting grants
    // first makes the reclamation explicit and keeps the blob deletion valid.
    this.db
      .prepare(
        `DELETE FROM channel_assets
          WHERE asset_id IN (
            SELECT id
              FROM assets
             WHERE unreferenced_at <= ?
               AND NOT EXISTS (
                 SELECT 1
                   FROM revisions r, json_each(r.asset_ids) asset_id
                  WHERE asset_id.value = assets.id
               )
          )`
      )
      .run(cutoff);
    this.db
      .prepare(
        `DELETE FROM assets
          WHERE unreferenced_at <= ?
            AND NOT EXISTS (
              SELECT 1
                FROM revisions r, json_each(r.asset_ids) asset_id
               WHERE asset_id.value = assets.id
            )`
      )
      .run(cutoff);
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

  /**
   * Stores the blob content-addressably (deduplicated globally by sha256 id)
   * and grants the uploading channel visibility of it. The grant -- not the
   * blob write -- decides 'granted' vs 'already_granted': re-uploading
   * identical bytes to the same channel is idempotent, but the first upload
   * of already-known bytes to a *different* channel still counts as newly
   * granted for that channel.
   */
  createAssetForChannel(
    channel: string,
    asset: { id: string; contentType: AssetContentType; byteLength: number; data: Uint8Array }
  ): 'granted' | 'already_granted' {
    const createdAt = Date.now();
    this.db.exec('BEGIN');
    try {
      // PNG and WebP signatures are mutually exclusive, so a dedup hit on id
      // (sha256 of bytes) can never legitimately disagree on content_type --
      // id is deliberately the only identity key here, not (id, content_type).
      this.db
        .prepare(
          `INSERT INTO assets (id, content_type, byte_length, data, createdAt, unreferenced_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
        )
        .run(asset.id, asset.contentType, asset.byteLength, asset.data, createdAt, createdAt);
      const grant = this.db
        .prepare(
          'INSERT INTO channel_assets (channel, asset_id, createdAt) VALUES (?, ?, ?) ON CONFLICT(channel, asset_id) DO NOTHING'
        )
        .run(channel, asset.id, Date.now());
      this.db.exec('COMMIT');
      return grant.changes > 0 ? 'granted' : 'already_granted';
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Undefined both when the asset id is unknown and when it was never granted to this channel -- the two are indistinguishable from outside. */
  getAssetForChannel(
    channel: string,
    id: string
  ): { contentType: AssetContentType; byteLength: number; sha256: string; data: Uint8Array } | undefined {
    const row = this.db
      .prepare(
        `SELECT a.content_type AS contentType, a.byte_length AS byteLength, a.data AS data
           FROM channel_assets ca
           JOIN assets a ON a.id = ca.asset_id
          WHERE ca.channel = ? AND ca.asset_id = ?`
      )
      .get(channel, id) as { contentType: string; byteLength: number; data: Uint8Array } | undefined;
    if (!row) return undefined;
    return { contentType: row.contentType as AssetContentType, byteLength: row.byteLength, sha256: id, data: row.data };
  }

  /** Which of `ids` this channel has not been granted -- used to reject a revision manifest before it ever reaches publishRevision. */
  findMissingAssetIds(channel: string, ids: string[]): string[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT asset_id AS assetId FROM channel_assets WHERE channel = ? AND asset_id IN (${placeholders})`)
      .all(channel, ...ids) as { assetId: string }[];
    const found = new Set(rows.map((r) => r.assetId));
    return ids.filter((id) => !found.has(id));
  }
}

/** Hashes only the HTML body -- two revisions with identical markup but different asset dependencies share a hash. */
function hashHtml(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex');
}

interface SourceRevisionRow {
  protocolVersion: number;
  profileVersion: number;
  html: Uint8Array;
  assetIds: string;
  title: string;
  description: string | null;
  contentHash: string | null;
}

const REVISION_SUMMARY_COLUMNS = `
  r.id, r.protocolVersion, r.title, r.description, r.profileVersion, r.asset_ids AS assetIds, r.content_hash AS contentHash,
  r.published_by AS publishedBy, t.label AS publishedByLabel, r.createdAt, r.rolled_back_from AS rolledBackFrom`;

const REVISION_SUMMARY_FROM = `
    FROM revisions r
    LEFT JOIN tokens t ON t.id = r.published_by`;

const SELECT_REVISION_SUMMARY = `SELECT ${REVISION_SUMMARY_COLUMNS}${REVISION_SUMMARY_FROM}`;

interface RevisionSummaryRow {
  id: string;
  protocolVersion: number;
  title: string;
  description: string | null;
  profileVersion: number;
  assetIds: string;
  contentHash: string | null;
  publishedBy: string | null;
  publishedByLabel: string | null;
  createdAt: number;
  rolledBackFrom: string | null;
}

function toRevisionSummary(channel: string, row: RevisionSummaryRow, currentId: string | null): RevisionSummary {
  return {
    // The protocol version this specific revision was published under, not
    // the server's current constant -- they happen to be equal today (there
    // is only one protocol version) but must not be conflated.
    protocolVersion: row.protocolVersion as RevisionSummary['protocolVersion'],
    id: row.id,
    channel,
    title: row.title,
    description: row.description,
    profileVersion: row.profileVersion,
    assetIds: JSON.parse(row.assetIds) as string[],
    contentHash: row.contentHash,
    publishedBy: row.publishedBy,
    publishedByLabel: row.publishedByLabel,
    createdAt: row.createdAt,
    rolledBackFrom: row.rolledBackFrom,
    current: row.id === currentId,
  };
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
