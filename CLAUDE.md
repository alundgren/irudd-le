## Agent skills

## Testing and TDD

Use a red → green loop only at an agreed public seam. Before the first test,
record the seam in the issue or PR plan; an accepted issue criterion may define
that seam when it names the public interface. Tests assert observable behaviour
through that interface, not private collaborators or implementation details.

For each vertical slice:

- add one failing focused test, run that single test, then make the smallest
  change that turns it green;
- run typechecking after structural or type-signature changes and before moving
  to the next slice;
- run the full test suite once after all slices are complete.

Use Corepack so the pinned pnpm version is used:

```bash
corepack pnpm typecheck
corepack pnpm --filter @irudd-le/protocol test
corepack pnpm test
```

Every command above must pass from a clean checkout, before anything has been
built. A package that depends on `@irudd-le/protocol` consumes its emitted
`build/` types, so its own `build`, `typecheck`, and `test` scripts must build
that dependency first, the way `apps/overlay` does:

```json
"typecheck": "corepack pnpm --filter @irudd-le/protocol build && tsc -p tsconfig.json --noEmit"
```

Relying on `corepack pnpm -r` ordering is not enough: it hides the gap until
someone runs a single package with `--filter`.

Because several packages then build `@irudd-le/protocol`, the root `build`,
`typecheck`, and `test` scripts pin `--workspace-concurrency=1` so two builds
never write its `build/` directory at once. Keep that flag.

Do refactoring during review, after the red → green slices are complete.

### Scope

Implement the issue in front of you and nothing else. Before starting, read the
issue's sub-issues and the issues it blocks, and treat anything they own as out
of scope even when the parent issue mentions it in passing. Say in the PR
description which neighbouring issues you deliberately left alone.

Prefer extending `packages/protocol` over re-implementing validation locally.
If a rule constrains a value that crosses the wire, it belongs in the shared
schema, not in an adapter.

### Issue tracker

Issues live in this repo's GitHub Issues (uses the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root (created lazily as needed). See `docs/agents/domain.md`.

### Releases

Publish a patch release only through the `release-overlay` skill.
