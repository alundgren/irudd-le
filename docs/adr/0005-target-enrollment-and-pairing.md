# Target enrollment and pairing: unauthenticated first contact, human-confirmed pairing

Issue #21 lets a fresh overlay register as an unassigned target, report its
real rendering profile, and be paired exactly once to a newly created named
channel. It sits directly on ADR-0004's scoped-credential model rather than
inventing a parallel one.

## Registration is the one unauthenticated `/v1/` write

`POST /v1/targets` sits outside the normal `authenticate()` gate in
`apps/mailbox/src/mailbox.ts` (`handle()` special-cases it before the generic
`/v1/` prefix check) because a brand-new overlay has no credential yet — there
is nothing to bootstrap it with the way `MAILBOX_ADMIN_BOOTSTRAP_TOKEN` seeds
the first admin token. This leans on the epic's stated deployment shape
(`CONTEXT.md` / issue #20): the mailbox is reached through a Cloudflare-
authenticated tunnel, so network-layer auth already gates who can reach `/v1/`
at all. The mailbox itself does not enforce that boundary and cannot verify
it is in place.

**Known limitation, left alone deliberately**: an unauthenticated write means
anyone who can reach the mailbox can create pending-target rows indefinitely.
There is no rate limiting and no cleanup of targets that register and never
get paired — they simply sit with `channel IS NULL` forever, distinguishable
from a live enrollment attempt only by `lastSeenAt` going stale. No issue
currently owns pending-row cleanup; if it becomes a problem, it is a small,
separate addition (e.g. an admin "prune stale pending targets" action) rather
than a reason to change the registration auth model.

## One `authenticate()`/`Principal` choke point, not two

A target's own secret (`tgt_<32 base64url chars>`, generated and hashed the
same way as ADR-0004's tokens) authenticates `PUT /v1/targets/:id/heartbeat`.
Rather than adding a second verification path alongside `authenticate()`,
`Principal.kind` is widened to a mailbox-local `TokenKind | 'target'` and
`authenticate()` falls back to `store.findTargetBySecretHash()` after the
tokens-table lookup misses. Every `/v1/*` route still funnels through the
same `authenticate()` / `canAccessChannel()` pair — ADR-0004's stated
invariant holds.

`target` was **not** added to `@irudd-le/protocol`'s wire `TokenKind` enum.
Unlike admin-minted publisher/reader tokens, a target credential is
self-issued at registration, lives in its own `targets` table (which also
carries `clientName`, the live `profile`, and pairing state — genuinely more
than a bearer credential), and its `channel` moves from `null` to an assigned
id exactly once, from the *inside* (pairing), rather than being fixed at
creation like every other token kind. Reusing the tokens table would have
meant special-casing "created without an admin credential" and "channel is
mutable after creation" onto a table whose whole contract (ADR-0004) is the
opposite of both.

Heartbeat is identity-bound, not scope-bound: `principal.kind === 'target' &&
principal.id === <url id>` is required, and — unlike every other route —
**admin does not get a blanket bypass**. There is nothing for a superuser to
usefully impersonate by heartbeating as a specific target; allowing it would
fabricate the exact liveness signal issue #24 is meant to observe later.

**Known limitation, left alone deliberately**: target secrets are not
revocable and don't appear in `GET /v1/admin/tokens` the way ADR-0004
credentials do. A re-enrolled overlay (see "Retargeting" below) leaves its
previous target row, and previous secret, alive and bound to its old channel
indefinitely. If that becomes a real operational problem, it is a natural
extension of ADR-0004's revocation model onto the `targets` table — not
attempted here because #21's acceptance criteria don't require it.

## Pairing always creates a new channel from the live profile

`POST /v1/admin/targets/:id/pair` (admin-only) creates a **new** channel from
the target's current reported `TargetProfile` and freezes that profile into
`channel_profiles` in the same transaction as assigning `targets.channel`.
It never attaches to a pre-existing channel.

This leaves **two ways to create a channel** — the direct
`POST /v1/channels` (admin, no profile, exists since #34/#32 and still used
by other tests and issues) and pairing (always-new, always with a profile).
Direct-created channels have no profile until *some* target is later paired
using that exact channel id, which pairing rejects if the id already exists
(`409 channel_exists`) — so in practice a directly created channel can never
retroactively gain a profile through pairing either. **This is a genuine
open question for the user, not a defect**: issue #31 expects to fetch "the
selected channel's current live or last-known profile," and a channel made
via the direct path can never have one under this design. Resolving it
(e.g. folding direct creation into "admin-only, still profile-less, for
non-overlay-backed testing channels only") is left to whoever picks up #31
or a dedicated follow-up.

## Pairing codes and the admin UI: proving physical possession, not authority

The registration response contains a six-digit `pairingCode` (`node:crypto`
`randomInt`, zero-padded) with a `pairingCodeExpiresAt` (`pairingCodeTtlMs` on
`MailboxOptions`, default 10 minutes). `GET /v1/admin/targets` deliberately
**omits** the code itself, returning only `pairingCodeExpiresAt` — the code is
shown only on the enrolling overlay's own screen (`#pairing-code` /
`enrollment-detail` in the overlay renderer). Pairing therefore requires a
human to read the code off the physical device and type it into the admin
form, which is how an admin distinguishes *this* pending target from any
other simultaneously-pending one when several overlays are being set up in
the same room. This is not an authorization boundary — the admin already has
full authority to pair any pending target regardless of the code — so
`pairTargetHandler`'s code comparison is a plain string `!==` with no attempt
limiting. That is intentional, not an oversight: the code proves "I am
looking at this device," not "I am allowed to do this."

## One target per channel; retargeting is a new target, not a channel move

`targets.channel` is `UNIQUE` (SQLite allows unlimited `NULL`s, so many
pending targets coexist while a paired one stays one-to-one with its
channel). `pairTarget()` re-checks pairing state inside its transaction
before inserting, so:

- pairing an already-paired target returns `409 target_already_paired`
  (there is no "re-pair to a different channel" operation), and
- two different targets racing for the same new channel id resolve to one
  `201` and one `409 channel_exists`.

"Explicit re-enrollment for retargeting" (the issue's scope line) is
satisfied by this being the *only* way to retarget: register again (new
target row, new id/secret/pairing code — see `EnrollmentManager.reEnroll()`
in the overlay) and pair that new registration to a channel. **This orphans
the old channel** — there is no route that lets an operator move an existing
named channel from one physical device to another; the old target row keeps
its old channel forever (see the credential-revocation limitation above).
Flagging this as an explicit product-scope call the user may want revisited,
not a bug: the issue only says "explicit re-enrollment for retargeting,"
which several implementations could satisfy.

`targets.channel` uses `ON DELETE SET NULL` against `channels.id`. No route
to delete a channel exists yet, so this is currently unreachable — but if one
is added later, `SET NULL` would silently strand a target that can still
authenticate (its secret still hashes and matches) but can never be re-paired
(its pairing code was already consumed at the original pairing). Worth
revisiting to `ON DELETE RESTRICT` (or an explicit target-release step)
alongside whichever issue adds channel deletion.

## The overlay side: local identity survives restart; profile is measured live

`apps/overlay/src/main/enrollment-store.ts` persists `{ mailboxUrl,
clientName, targetId, secret, channel }` as JSON in Electron's `userData`
directory (write-to-temp-then-rename for atomicity). `EnrollmentManager`
(`enrollment.ts`) loads it at construction: if `channel` is already set, the
overlay is `paired` immediately from local state alone — no heartbeat round
trip is needed to know the assignment, which is what makes "restarting
preserves the assignment" true even fully offline. A background heartbeat
(`config.enrollment.heartbeatIntervalMs`, default 20s) keeps the reported
profile live and picks up a pairing that happened while pending.

The window has no local content to show until it is enrolled *and* paired
(there is no sane default mailbox URL — it's Pi-hosted and operator-chosen),
so `apps/overlay/src/main/index.ts` forces `startInteractive` whenever
`loadEnrollment()` is empty or unpaired, regardless of `config.startInteractive`.
This reuses the existing local-setup surface (`#local-setup`) rather than
adding a second window or mode.

`TargetProfile.contentBox`, `.devicePixelRatio`, and `.screenshot` are
measured live from the renderer's `#content-box` via
`webContents.executeJavaScript` (main process, bypasses the page's own CSP —
this is the standard Electron embedder-to-page channel, not a script the page
itself runs). `preferredIconSize`, `minimumTextSize`, `background.opaque` and
`features` are static properties of *this* content shell implementation, not
per-session measurements, and live in `config.ts` next to the window/shortcut
knobs it already centralizes.
