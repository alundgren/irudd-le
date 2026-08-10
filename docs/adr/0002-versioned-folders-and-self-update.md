# Versioned folders, a launcher, and unattended self-update

Shipping a zip rather than an installer
([ADR-0001](./0001-packager-zip-and-ci-cross-build.md)) means nothing on the
player's machine knows how to install anything. The overlay updates itself
instead.

An install root holds one version folder per installed version. Updating writes
a new version folder alongside the existing ones; nothing is ever overwritten,
which sidesteps the fact that a running `.exe` cannot be replaced on Windows. A
launcher in the install root resolves the newest version folder and starts it,
so a pinned taskbar shortcut survives every update. Rollback is deleting a
folder.

Update is fully unattended: the overlay checks for a release on an interval,
and on finding a newer one it downloads, verifies, and restarts into it with no
input from the player. This follows directly from couch distance — the player is
watching a TV with a controller and no mouse, so any update path with a button
in it is an update path that does not happen.

## Considered options

**A `current` junction re-pointed on update** was rejected: something has to
re-point it after the outgoing process exits, and a dying process is a poor
place for work that must not fail. **Rewriting the Windows shortcut** was
rejected for the dependency cost of writing `.lnk` files. "Newest folder wins"
needs neither.

**A manual "check for update" control** was chosen first and then reversed once
couch distance was understood. It is unreachable in the setup the overlay
actually runs in.

**Marking each release as a prerelease** (to keep the releases list tidy) was
reversed for a concrete reason: GitHub's stable `releases/latest/download/…`
URL skips prereleases, which would force update checks onto the GitHub API and
its 60-requests-per-hour unauthenticated cap. At a 60-second interval that sits
exactly on the ceiling, shared with everything else on the same connection.
Plain releases keep checks off the API entirely. A long releases list is
cosmetic; a rate limit is the loop breaking.

## Consequences

- Every release is an ordinary, ordered, immutable release. No rolling tag —
  ordering is what makes "is this newer?" answerable and downgrades detectable.
- Downloads are verified against a digest published with the release. Unsigned
  artifacts (ADR-0001) mean this is the only integrity check in the chain.
- The overlay can restart itself mid-session, including mid-fight. Accepted
  while the author is the only user; it will need gating before that changes.
- Version folders accumulate; nothing prunes them yet.
- Outside an install root — a `pnpm dev` build on macOS — there is nothing to
  update. The control acknowledges the click and does nothing.
