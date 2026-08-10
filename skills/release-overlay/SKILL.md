---
name: release-overlay
description: Publish the next patch release of the Last Epoch Overlay. Use when asked to release, publish, or ship a new version of this repository.
---

# Release overlay

Publish one patch release from the current branch.

1. Require a clean working tree before starting. Stop and report any existing changes; do not mix them into a release.
2. Run `pnpm version patch --no-git-tag-version`, capture the resulting version from `package.json`, and run `pnpm typecheck`.
3. Commit the version files as `Release v<version>` and push the current branch.
4. Record the newest existing `workflow_dispatch` run id for `release.yml`, then run `gh workflow run release.yml --ref <current-branch>`. Poll `gh run list --workflow release.yml --event workflow_dispatch --branch <current-branch>` until a different run appears, and wait for it with `gh run watch <id> --exit-status`.
5. On success, run `gh release view v<version> --json url,isPrerelease,assets`. Require `isPrerelease` to be false and both `last-epoch-overlay-<version>-win32-x64.zip` and `last-epoch-overlay-update.json` to be present. Report the release URL.

Stop on a failed check, push, workflow, or release validation. Do not create a tag or release locally: the workflow is the sole publisher.
