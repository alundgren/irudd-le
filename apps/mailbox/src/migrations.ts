import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocolVersion INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE revisions (
        channel TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        protocolVersion INTEGER NOT NULL,
        profileVersion INTEGER NOT NULL,
        html BLOB NOT NULL,
        asset_ids TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (channel, id)
      );

      CREATE TABLE channel_current_revisions (
        channel TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE tokens (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        channel TEXT NULL REFERENCES channels(id),
        label TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        revokedAt INTEGER NULL
      );

      CREATE UNIQUE INDEX tokens_secret_hash ON tokens (secret_hash);
      CREATE INDEX tokens_kind ON tokens (kind);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE targets (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        client_name TEXT NOT NULL,
        profile TEXT NOT NULL,
        channel TEXT NULL UNIQUE REFERENCES channels(id) ON DELETE SET NULL,
        pairing_code TEXT NULL,
        pairing_code_expires_at INTEGER NULL,
        createdAt INTEGER NOT NULL,
        lastSeenAt INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX targets_secret_hash ON targets (secret_hash);

      CREATE TABLE channel_profiles (
        channel TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
        profile TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE targets ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE targets ADD COLUMN client_version TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE targets ADD COLUMN profile_changed_at INTEGER NULL;
      ALTER TABLE targets ADD COLUMN republish_recommended INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE render_statuses (
        target_id TEXT PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        attempt_started_at INTEGER NOT NULL,
        profile_version INTEGER NOT NULL,
        current_revision_id TEXT NULL,
        candidate_revision_id TEXT NULL,
        rendered TEXT NOT NULL,
        overflow TEXT NOT NULL,
        activation TEXT NOT NULL,
        failure_reason TEXT NULL,
        observed_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 5,
    sql: `
      -- Honest placeholders for rows published before this migration: a real
      -- empty string would satisfy NOT NULL but be indistinguishable from a
      -- deliberately blank title, and a shared '' content hash would make
      -- every legacy revision compare equal under hash-based dedupe.
      ALTER TABLE revisions ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled revision';
      ALTER TABLE revisions ADD COLUMN description TEXT NULL;
      ALTER TABLE revisions ADD COLUMN content_hash TEXT NULL;
      ALTER TABLE revisions ADD COLUMN published_by TEXT NULL REFERENCES tokens(id);
      -- Not a real FK: retention deleting the source of a past rollback must
      -- not fail (ON DELETE SET NULL would erase exactly the audit trail
      -- rollback exists to preserve), so this just records an id that may no
      -- longer resolve to a row.
      ALTER TABLE revisions ADD COLUMN rolled_back_from TEXT NULL;

      -- SQLite cannot ALTER TABLE ADD a foreign key, so the pointer table is
      -- rebuilt to reference revisions(channel, id) directly. Retention can
      -- no longer leave channel_current_revisions dangling at an id it just
      -- deleted. The copy is filtered (rather than relying on the new FK to
      -- reject bad rows) because PRAGMA foreign_keys cannot be toggled off
      -- inside this transaction, so a pre-existing dangling pointer would
      -- otherwise abort the whole migration and leave the mailbox unable to
      -- start.
      CREATE TABLE channel_current_revisions_new (
        channel TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (channel, revision_id) REFERENCES revisions(channel, id)
      );
      INSERT INTO channel_current_revisions_new (channel, revision_id, updatedAt)
        SELECT c.channel, c.revision_id, c.updatedAt
          FROM channel_current_revisions c
         WHERE EXISTS (SELECT 1 FROM revisions r WHERE r.channel = c.channel AND r.id = c.revision_id);
      DROP TABLE channel_current_revisions;
      ALTER TABLE channel_current_revisions_new RENAME TO channel_current_revisions;
    `,
  },
  {
    version: 6,
    sql: `
      -- Content-addressed: id is the sha256 hex digest of the bytes, so
      -- identical uploads (even from different channels) dedupe onto one row.
      -- Not tied to revisions.asset_ids (still a plain JSON column on
      -- revisions), so retention sweeping old revisions never has to touch
      -- this table -- reclaiming unreferenced rows is deliberately deferred.
      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        content_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        data BLOB NOT NULL,
        createdAt INTEGER NOT NULL
      );

      -- Grants a channel visibility of an asset. The blob store above is
      -- global and deduplicated, but access is per channel: a publisher
      -- token for one channel must not be able to fetch an asset it never
      -- uploaded just because another channel happened to upload the same
      -- bytes first, and a revision may only reference an asset id its own
      -- channel has been granted.
      CREATE TABLE channel_assets (
        channel TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (channel, asset_id)
      );
    `,
  },
  {
    version: 7,
    sql: `
      -- NULL means the blob is still referenced by at least one retained
      -- revision. A timestamp starts the grace period once the last such
      -- reference has gone away.
      ALTER TABLE assets ADD COLUMN unreferenced_at INTEGER NULL;
    `,
  },
];

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  for (const m of MIGRATIONS) {
    const applied = db.prepare('SELECT 1 AS hit FROM migrations WHERE version = ?').get(m.version);
    if (applied) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
