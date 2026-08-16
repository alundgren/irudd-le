import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { MIGRATIONS, runMigrations } from './migrations';

/**
 * Applies only the pre-v5 migrations, bypassing `runMigrations` so a v5-era
 * invariant (the FK from `channel_current_revisions` to `revisions`) can be
 * violated the way a database created before v5 legitimately could be.
 */
function seedPreV5Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const migration of MIGRATIONS) {
    if (migration.version >= 5) continue;
    db.exec(migration.sql);
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(migration.version, Date.now());
  }
  return db;
}

test('migration v5 tolerates a pre-existing dangling current-revision pointer without aborting startup', () => {
  const db = seedPreV5Database();
  db.exec("INSERT INTO channels (id, name, protocolVersion, createdAt) VALUES ('main', 'Main', 1, 0)");
  db.exec("INSERT INTO channels (id, name, protocolVersion, createdAt) VALUES ('orphan', 'Orphan', 1, 0)");
  db.exec(
    "INSERT INTO revisions (channel, id, protocolVersion, profileVersion, html, asset_ids, createdAt) VALUES ('main', 'rev-001', 1, 1, x'3c703e68656c6c6f3c2f703e', '[]', 0)"
  );
  db.exec("INSERT INTO channel_current_revisions (channel, revision_id, updatedAt) VALUES ('main', 'rev-001', 0)");
  // 'orphan' points at a revision id that was never inserted -- the exact
  // shape of dangling pointer the missing FK previously allowed.
  db.exec("INSERT INTO channel_current_revisions (channel, revision_id, updatedAt) VALUES ('orphan', 'ghost-revision', 0)");

  assert.doesNotThrow(() => runMigrations(db));

  const valid = db.prepare('SELECT revision_id AS revisionId FROM channel_current_revisions WHERE channel = ?').get('main') as
    | { revisionId: string }
    | undefined;
  assert.equal(valid?.revisionId, 'rev-001');

  const dangling = db.prepare('SELECT 1 AS hit FROM channel_current_revisions WHERE channel = ?').get('orphan');
  assert.equal(dangling, undefined);

  db.close();
});
