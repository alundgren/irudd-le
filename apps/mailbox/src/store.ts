import { DatabaseSync } from 'node:sqlite';
import { PROTOCOL_VERSION, type Channel, type Revision, type TokenKind } from '@irudd-le/protocol';
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
