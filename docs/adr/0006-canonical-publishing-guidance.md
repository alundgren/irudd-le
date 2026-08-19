# Canonical publishing guidance lives in the protocol package

Issue #22 asks for one canonical, versioned set of instructions that a fresh
agent can follow to publish through either supported path, with the CLI help
and the browser-facing copy kept synchronized from it. "Synchronized" has to
be a mechanism, not a promise: two prose copies with a note asking future
authors to keep them aligned is exactly the drift this issue exists to remove.

## The guide is data in `@irudd-le/protocol`, rendered twice

`PUBLISHING_GUIDE` is a plain, structured value exported from
`packages/protocol/src/guidance.ts` and re-exported from the package entry
point: typed sections, an example workflow whose
CLI steps are literal argv arrays, and a list of subjects the guidance
deliberately never covers. `renderPublishingGuideText()` renders it as the
plain text `irudd-le-mailbox help` prints; `publishingGuideMarkup()` in
`apps/upload-ui` renders the same value as escaped page markup. Neither
surface owns any guidance prose of its own, so they cannot disagree.

Contract facts the guide quotes come from the contract, not from a second
copy of it: `CHANNEL_ID_PATTERN`, `ASSET_CONTENT_TYPES`,
`REVISION_TITLE_MAX_LENGTH`, `REVISION_DESCRIPTION_MAX_LENGTH`, and
`PROTOCOL_VERSION` are the same values the schemas enforce. Changing a limit
changes the published guidance in the same commit, or the protocol tests fail.

The package's ESM build has a single entry point, because `apps/upload-ui`
reaches it through one `importmap` entry. Splitting the guidance into its own
module therefore required the constants it quotes to move into
`packages/protocol/src/contract.ts`, which both `index.ts` and `guidance.ts`
import: a guidance module importing the schema module would have produced both
an import cycle and, after the ESM entry point is renamed to `index.mjs`, a
dangling `./index.js` specifier in the browser. `contract.ts` is an internal
seam; every constant is still re-exported from the package entry point.

This widens `CONTEXT.md`'s boundary for the package from "versioned runtime
schemas and all shared protocol types" to include the canonical guidance for
using that contract; `CONTEXT.md` is amended to say so.

### Alternatives rejected

- **A `packages/guidance` workspace package.** A whole deliverable — manifest,
  build, typecheck, focused-test wiring, and an `importmap` entry plus
  `copy-static.mjs` handling in `apps/upload-ui` — to export one constant that
  every consumer already reaches through the protocol package.
- **A markdown file in `docs/` with a generator or a drift-check script.** The
  browser bundle cannot import markdown without new tooling, and a generated
  copy is only as reliable as remembering to run the generator.

## Versioning is a document revision, not the protocol version

`PUBLISHING_GUIDE_VERSION` is bumped whenever the guidance text changes and is
independent of `PROTOCOL_VERSION`; the guide separately carries
`protocolVersion` to state which contract it describes. Advice improves far
more often than the wire format does, and a clarified sentence must not look
like a breaking protocol change to a client that gates on version numbers.

## The example workflow is executed, not illustrated

`packages/cli/src/guided-workflow.test.ts` runs the guide's own
`exampleWorkflow` argv arrays through the CLI's `run()` against a mailbox
stub, threading the asset id printed by the upload step into the publish step
through `PUBLISHING_GUIDE_ASSET_ID_PLACEHOLDER`. It is the fresh-agent fixture
issue #22's definition of done asks for: if a documented command stops
working, or the workflow stops being internally coherent, that test fails
rather than the guidance quietly becoming wrong.

## The CLI now reports overflow, because the guidance would otherwise lie

`renderStatusSchema` constrains revision ids and the failure reason for an
`active` activation, but overflow is independent of activation: a revision can
be active *and* overflow its content box, which is the silent-truncation case
an author is least able to notice. `formatInspection` previously dropped both
`rendered` and `overflow` even though `inspectChannel` already fetches and
validates them. Guidance that told an agent on the preferred CLI path to query
the raw endpoint to learn why its revision was rejected would be documenting a
workaround around this project's own thin client, so the formatter now prints
the measured size and the overflow axes for every observation.
