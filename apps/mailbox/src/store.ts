import { DatabaseSync } from 'node:sqlite';
import { PROTOCOL_VERSION, type Channel, type Revision } from '@irudd-le/protocol';
import { runMigrations } from './migrations';

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

  publishRevision(channel: string, revision: Revision): void {
    const htmlBlob = Buffer.from(revision.html, 'utf8');
    const assetIdsJson = JSON.stringify(revision.assetIds);
    this.db.exec('BEGIN');
    try {
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
}