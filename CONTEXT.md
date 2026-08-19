# irudd-le

irudd-le is a passive **overlay** for Last Epoch. A player reads it at **couch
distance** beside the running game; normal operation never requires mouse or
keyboard input. A durable mailbox owns named channels and revisions. Clients
publish static HTML to a channel, and one enrolled overlay target displays its
latest valid revision.

## Ubiquitous language

**Overlay**: the always-on-top Electron window beside the running game. Avoid:
HUD, widget, panel.

**Content shell**: the passive overlay plus its scriptless rendering boundary.
It displays an active revision but does not own publication state.

**Mailbox**: the durable, networked authority for channels, revisions, assets,
targets, and render observations. It is not an overlay controller.

**Channel**: a stable, named publication destination with one live overlay
target. It remains meaningful while its target is offline.

**Target**: an overlay instance registered with the mailbox. A **pending
target** has reported its live **target profile** (locked content box and
capabilities) but has no channel yet; **pairing** assigns it exactly one
newly created channel, using a short-lived **pairing code** shown only on the
target's own screen to confirm physical possession. See ADR-0005.

**Revision**: an immutable published HTML document plus its profile version and
asset dependencies. A new publication activates atomically or leaves the prior
revision visible.

**Render status**: a target's observation of the candidate/current revision,
dimensions, overflow, and activation result.

**Credential**: a hashed mailbox bearer secret of one **kind** — `admin`
(unscoped), `publisher`, or `reader` (each bound to one channel, revocable).
The full secret is shown only once, at creation. See ADR-0004. A target's own
secret (self-issued at registration, not revocable) authenticates the same
way but is not a credential of one of these three kinds — see ADR-0005.

**Principal**: the credential kind (or `target`) and channel a request
authenticated as, used to decide whether it may act on a given channel.
Avoid: user, identity — a credential is not tied to a human account.

**Protocol**: the shared, runtime-validated contract. An unsupported protocol
version fails explicitly; adapters reuse it and do not reproduce its types.

**Couch distance**: the operating assumption that the player cannot reach a
mouse or keyboard. Avoid: TV mode, lean-back.

**Click-through**: the window state where mouse input passes beneath the
overlay. **Interactive** is reserved for deliberate local setup/recovery, not
ordinary content consumption.

**Release**, **install root**, **version folder**, **launcher**, **update
check**, and **self-update** keep the meanings recorded in ADR-0002. Version
folders are never modified in place.

## Boundaries

- `packages/protocol`: versioned runtime schemas, all shared protocol types, and
  the canonical publishing guidance every client surface renders (see ADR-0006).
- `apps/overlay`: Electron content shell, preload security boundary, packaging,
  launcher, setup/recovery shortcuts, and self-update.
- `apps/mailbox`: the durable HTTP authority. It also serves its own narrow,
  unauthenticated-page/authenticated-API admin UI at `/admin` (see ADR-0004)
  rather than a separate app.
- `apps/upload-ui`: future universal direct-publish UI.
- `packages/cli`: thin protocol client for SSH-connected agents (inspect a
  channel, publish self-contained HTML). `packages/mcp`: future thin protocol
  adapter.

The mailbox HTTP API is canonical. The upload UI, CLI, and stateless MCP
adapter do not own business state. Static HTML/CSS is trusted for presentation
inside a sandbox; published script and navigation never run.

The previous controller-driven and placeholder-planner direction is
superseded. `docs/research/xbox-controller-overlay-feasibility.md` remains as
historical research, not a product roadmap.
