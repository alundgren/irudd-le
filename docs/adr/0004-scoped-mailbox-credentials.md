# Scoped mailbox credentials: hashed, revocable, least-authority tokens

Issue #32 replaces the MVP flat bearer secret (ADR-0003) with three credential
kinds, each carrying the minimum authority its holder needs.

## Three kinds, one choke point

`admin` (unscoped), `publisher` (bound to one channel), and `reader` (bound to
one channel) are the only token kinds. `isAuthorized()` from the MVP is
replaced by `authenticate()` plus `canAccessChannel()` in
`apps/mailbox/src/mailbox.ts`; every `/v1/*` route still funnels through this
one pair of functions rather than each handler inventing its own check. An
admin token satisfies every scope check — it is the superuser needed for
channel lifecycle and token management, and the issue's acceptance criteria
never require withholding a capability from it.

`CreateTokenRequest` cross the wire, so its validation (a channel is required
for `publisher`/`reader` and forbidden for `admin`) lives in
`packages/protocol`, not in the mailbox adapter, per this repo's convention of
keeping wire rules in the shared schema.

## Tokens are hashed, never stored or logged in full

A token's secret is `<kind-prefix>_<32 random base64url chars>` (24 bytes from
`crypto.randomBytes`), generated only at creation and returned to the caller
exactly once in the create response. The mailbox stores only
`sha256(secret)` in the `tokens.secret_hash` column and authenticates by
hashing the presented bearer value and looking up that hash. Unlike a
password hash, no slow KDF (bcrypt/argon2/scrypt) is needed: the secret
itself already has ~192 bits of entropy, so the hash lookup is not exposed to
offline brute-forcing the way a low-entropy password would be. This argument
holds for mailbox-generated secrets; it does not hold for
`MAILBOX_ADMIN_BOOTSTRAP_TOKEN`, whose entropy is whatever the operator
chose. Generate that value the same way (e.g. `openssl rand -base64 24`)
rather than typing something memorable.

## Revocation is a soft delete, on purpose

`revokeToken()` sets `revokedAt` and keeps the row — it never `DELETE`s.
`findActiveTokenByHash()` filters `revokedAt IS NULL`, so a revoked token
stops authenticating on the very next request with no process restart
required, satisfying the issue's "revocation takes effect without restarting
the mailbox" criterion. Keeping the row (id + label) intact also matters for
the *other* criterion, "existing revisions remain attributable after a token
is revoked": #26 (still open) owns adding a publisher/token reference to the
`revisions` table, and that link would be unrecoverable if revoke destroyed
the row it points at. Revoking a nonexistent id still 404s; revoking an
already-revoked id is idempotent (204).

Since bootstrapping only ever seeds once per database (see below), revoking
the *last active* admin token would otherwise be an unrecoverable lockout —
every `/v1/admin/*` route requires an admin credential, and none would exist.
`revokeTokenHandler` refuses that one case with `409 last_admin_token`;
revoking any other admin token, or an admin token when another admin is still
active, proceeds normally.

## Bootstrapping the first admin token

A brand-new database has no tokens at all, so nothing could call the admin
API to create the first one. `bootstrapAdminToken()` seeds exactly one admin
token from `MAILBOX_ADMIN_BOOTSTRAP_TOKEN` (`adminBootstrapToken` in
`MailboxOptions`) the first time a database is opened — checked by "does an
admin token, revoked or not, already exist anywhere in this file" — and never
again. This means: revoking the bootstrap token and restarting does not
resurrect it (the env var is ignored, with a log line, once any admin token
has ever existed), and a fresh database with no env var set fails `start()`
outright rather than serving unauthenticated admin endpoints. This mirrors the
MVP's old "refuse to start with no tokens" behavior but scoped to admin-only.

Note also that a request's `Principal.tokenId` (`mailbox.ts`) is captured on
every authenticated request but not yet written anywhere — it is the exact
seam #26 needs to attribute a revision to the token that published it, kept
unused on purpose rather than removed as dead code.

## The admin UI is a static page served by the mailbox itself

"Narrow admin web UI" is met by `apps/mailbox/src/admin-ui.ts`: a single
inline-styled, inline-scripted HTML string served at `GET /admin` with no
auth on the page load (only the API calls it makes are authenticated — the
admin pastes their token into a field, same shape as any bearer-token admin
console). This avoids standing up a new app, a build step, or a static-asset
pipeline in the Docker image for what the issue explicitly scopes as narrow:
create a channel, create a token (kind + channel + label), see the secret
once, list tokens, revoke one. `CONTEXT.md`'s boundary list has no admin app
of its own — `apps/upload-ui` is the future *publish* UI, not this — so
housing it inside `apps/mailbox` next to the API it drives was the smaller
surface, not a new package under `apps/`.

## Left alone, deliberately

- **Publisher identity on `revisions` rows** (the "token labels recorded in
  revision history" scope line): #26 owns adding metadata to the revisions
  table and is still open. Wiring a token/label reference into `revisions` is
  left for that issue; this PR only guarantees the token side stays
  attributable (see "Revocation is a soft delete" above).
- **The rollback endpoint itself**: #32 grants admin the *authority* structure
  for it, but the endpoint is #26's.
