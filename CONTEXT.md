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

**Target**: an enrolled overlay instance. Its **target profile** describes the
locked content box and capabilities used to compose a fitting document.

**Revision**: an immutable published HTML document plus its profile version and
asset dependencies. A new publication activates atomically or leaves the prior
revision visible.

**Render status**: a target's observation of the candidate/current revision,
dimensions, overflow, and activation result.

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

- `packages/protocol`: versioned runtime schemas and all shared protocol types.
- `apps/overlay`: Electron content shell, preload security boundary, packaging,
  launcher, setup/recovery shortcuts, and self-update.
- `apps/mailbox`: future durable HTTP authority.
- `apps/upload-ui`: future universal direct-publish UI.
- `packages/cli` and `packages/mcp`: future thin protocol clients/adapters.

The mailbox HTTP API is canonical. The upload UI, CLI, and stateless MCP
adapter do not own business state. Static HTML/CSS is trusted for presentation
inside a sandbox; published script and navigation never run.

The previous controller-driven and placeholder-planner direction is
superseded. `docs/research/xbox-controller-overlay-feasibility.md` remains as
historical research, not a product roadmap.
