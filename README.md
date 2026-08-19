# irudd-le — Last Epoch passive content shell

irudd-le displays agent-published, static reference content beside Last Epoch.
The normal overlay is content-only and click-through: it is designed to be read
at couch distance, not operated during play.

The durable mailbox is the authority for named channels, revisions, assets, and
render observations. The Electron overlay connects outward, receives the latest
valid revision, and renders it in a scriptless sandbox. Upload UI, CLI, and MCP
surfaces are thin clients of the same versioned HTTP contract.

## Workspace

| Package | Responsibility | Planned work |
| --- | --- | --- |
| `@irudd-le/protocol` | Runtime-validated shared protocol | This issue |
| `@irudd-le/overlay` | Electron shell, secure preload, packaging, launcher, self-update | #23, #21, #28 |
| `@irudd-le/mailbox` | Durable HTTP/SQLite authority | #34 |
| `@irudd-le/upload-ui` | Browser publishing fallback | #31 |
| `@irudd-le/cli` | Local command-line client | #29 |
| `@irudd-le/mcp` | Stateless remote MCP adapter | #35 |

Every deployable package has its own manifest and version. The protocol package
is the one place that defines both the runtime schemas and inferred domain
types for channels, target profiles, revisions, render status, assets, and
errors. Clients must reject unsupported protocol versions explicitly.

## Development

Requires Node and Corepack. Corepack selects the pinned pnpm version.

```bash
corepack pnpm install
corepack pnpm dev
```

The root overlay commands remain convenient compatibility entry points:

| Command | Replacement / purpose |
| --- | --- |
| `corepack pnpm dev` | Develop the Electron overlay |
| `corepack pnpm start` | Build and start the overlay once |
| `corepack pnpm start:interactive` | Start in deliberate local recovery mode |
| `corepack pnpm package:win` | Build the Windows overlay zip |
| `corepack pnpm typecheck` | Check every package |
| `corepack pnpm test` | Run every package test suite |
| `corepack pnpm --filter @irudd-le/protocol test` | Run protocol boundary tests only |

The Windows package is written to `apps/overlay/dist/`. It still contains the
stable `Last Epoch Overlay.vbs` launcher plus an immutable version folder; see
[ADR-0001](docs/adr/0001-packager-zip-and-ci-cross-build.md) and
[ADR-0002](docs/adr/0002-versioned-folders-and-self-update.md). Release only
through the repository’s `release-overlay` workflow.

## Product direction

One live overlay target belongs to a named channel. On enrollment, the target
reports a target profile: content-box dimensions, pixel ratio, screenshot
dimensions, icon/text preferences, background, capabilities, and protocol
version. Publications target that locked profile, activate atomically, and
preserve the previous revision on failure.

Published documents are static HTML/CSS/SVG with data images or mailbox-managed
assets. The content shell disables scripts, navigation, forms, and access to
the preload bridge. Later work adds delivery/reconnect, render feedback,
history, uploads, and credentials as separate vertical slices.

Mailbox-managed PNG/WebP images use `<img src="asset:<immutable-sha256>">`.
The overlay retrieves and verifies each declared asset in its authenticated main
process, then substitutes a data URL only inside the opaque content sandbox.
Published documents cannot use ordinary network image URLs.

## Publishing guidance

`@irudd-le/protocol` exports `PUBLISHING_GUIDE`, the one canonical set of
instructions for publishing to a channel. Both client surfaces render that
same value rather than keeping prose of their own, so they cannot drift:

```bash
corepack pnpm --filter @irudd-le/cli build
node packages/cli/build/index.js help
```

The browser UI shows the same guidance inline on its publishing page. See
[ADR-0006](docs/adr/0006-canonical-publishing-guidance.md) for why it lives in
the protocol package and how it is versioned.

The old placeholder planner, tabs, and controller-first direction are
superseded. The controller research remains at
`docs/research/xbox-controller-overlay-feasibility.md` as historical context.

## Testing

Tests are written at public seams in small red → green slices. The protocol
package’s parsing API is the initial seam. Run one source test file at a time
with `test:focused`; each command builds the selected package and its workspace
dependencies before invoking only that test program:

| Package / runner | Focused command |
| --- | --- |
| Protocol compiled TypeScript | `corepack pnpm --filter @irudd-le/protocol test:focused -- src/index.test.ts` |
| Mailbox compiled TypeScript | `corepack pnpm --filter @irudd-le/mailbox test:focused -- src/mailbox.test.ts` |
| Overlay compiled TypeScript | `corepack pnpm --filter @irudd-le/overlay test:focused -- src/main/revision-cache.test.ts` |
| Overlay direct Node MJS | `corepack pnpm --filter @irudd-le/overlay test:focused -- test/measurement-bootstrap.test.mjs` |
| Upload UI direct Node MJS | `corepack pnpm --filter @irudd-le/upload-ui test:focused -- test/upload-client.test.mjs` |
| Upload UI Electron browser harness | `corepack pnpm --filter @irudd-le/upload-ui test:focused -- test/browser-harness.cjs` |
| CLI compiled TypeScript | `corepack pnpm --filter @irudd-le/cli test:focused -- src/client.test.ts` |
| CLI guided-workflow fixture | `corepack pnpm --filter @irudd-le/cli test:focused -- src/guided-workflow.test.ts` |

Pass exactly one source test-file path after `--`; the command never adds a
package’s suite glob. See [AGENTS.md](AGENTS.md) for the required focused-test,
typecheck, and full-suite cadence.
