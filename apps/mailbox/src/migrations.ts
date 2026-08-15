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