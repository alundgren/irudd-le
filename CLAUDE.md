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

Do refactoring during review, after the red → green slices are complete.

### Issue tracker

Issues live in this repo's GitHub Issues (uses the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root (created lazily as needed). See `docs/agents/domain.md`.

### Releases

Publish a patch release only through the `release-overlay` skill.
