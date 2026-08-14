# Mailbox authority: `node:sqlite`, BLOB content, transactional publishes

The mailbox is the durable, networked authority for channels, revisions,
assets, and (later) render observations. Issue #34 landed the first vertical
slice: channels, current revisions, opaque bearer auth, health/readiness, and a
Dockerfile that mounts a single SQLite database file as the durable volume.

## Built-in `node:sqlite`, not a third-party binding

`better-sqlite3` and the others are mature but ship as native addons. Node 24
ships `node:sqlite` (`DatabaseSync`) without an experimental flag, and the
mailbox uses only built-in modules otherwise (`node:http`, `node:sqlite`,
`node:fs`, `node:os`, `node:path`). That keeps the production image on a
`node:24-slim` runtime with no native build step and no N-API surface, which
matters because the only alternative was bundling a build toolchain or
maintaining a prebuilt binary for every deploy target.

The flip-side: `node:sqlite` is still a young API and is subject to upstream
changes. The mailbox owns the database through a small `Store` module that
centralises every `DatabaseSync` call, so a future API change is contained to
one file rather than scattered across the HTTP layer.

## One database file, one migration source

Migrations are version-numbered SQL strings applied inside their own
transaction by a tiny runner that records progress in a `migrations` table. The
volume Dockerfile path is `/var/lib/mailbox/mailbox.db`; the path is overridden
via `MAILBOX_DATABASE_PATH` (and the `:memory:` form is used in tests). One
volume mount is the whole durable state — there is no blob bucket or external
store alongside it.

## Content as BLOBs

`revisions.html` is stored in a `BLOB` column, written as UTF-8 bytes and read
back through `Buffer.from(blob).toString('utf8')`. Issue #34 names HTML,
assets, and later screenshots as SQLite BLOB content, and the migration already
reserves the same storage class for the asset table that #33 will introduce.
Storing HTML as bytes rather than `TEXT` is a deliberate choice to treat all
binary content uniformly — the same shape will serve asset BLOBs without a
schema split.

## Atomic publication preserves the prior revision

The protocol glossary says a new publication "activates atomically or leaves
the prior revision visible." The API enforces that with a single SQLite
transaction that inserts the new revision row and updates
`channel_current_revisions` together; any failure rolls both back. Re-publishing
an existing `(channel, id)` raises a primary-key conflict inside that
transaction, and the conflict response exposes it as `409 revision_conflict`
without disturbing the existing current pointer. The red/green slice named
"atomic failure" exercises this exact failure path through the public HTTP
seam.

## Authentication: opaque bearer tokens

MVP tokens are opaque — the mailbox only does a constant-time comparison
against `MAILBOX_BEARER_TOKENS`. Scoped publisher/read/admin credentials
arrive in #32; the API currently treats every token as a single authority,
which is intentionally narrower than the eventual capability model. Tokens are
required on every `/v1/*` endpoint, while `/healthz` and `/readyz` are open so
that orchestrators and the in-image `HEALTHCHECK` probe can reach them without
a credential.

## Versioning and errors

The HTTP path version (`/v1/...`) and the message version
(`protocolVersion: 1` from `@irudd-le/protocol`) move together for now. Every
error response is shaped like `protocolErrorSchema`: 
`{ protocolVersion: 1, code, message }`. An unsupported body version is
rejected explicitly with code `unsupported_protocol_version`, so a client that
speaks a newer protocol gets back a server-versioned error rather than a
silent downgrade.