# Package with @electron/packager, cross-built on CI, delivered as a zip

The overlay is maintained by one hobbyist who cannot actively watch its
dependency tree, so the tree is the attack surface. `electron-builder` accounts
for the overwhelming majority of it. We measured the alternatives rather than
estimating them:

| Toolchain | Transitive packages |
| --- | --- |
| `electron-builder@26` (+ `electron-updater@6`) | 281 |
| `@electron/packager@20` | 48 |
| `electron-winstaller@5` (Squirrel) | 33 |

We adopt `@electron/packager@20` and drop `electron-builder`, removing roughly
230 packages. `@electron/packager@20` depends on `resedit`, a pure-JS PE editor,
not the old `node-rcedit` — so a Windows build needs no Wine and cross-builds
cleanly from a non-Windows machine. The widely repeated "you need Wine on macOS"
advice describes electron-packager v12 and is obsolete.

`@electron/packager` produces an app directory rather than an installer, and we
deliver exactly that, zipped. No NSIS, no Squirrel, no installer at all. This is
what makes the [update model](./0002-versioned-folders-and-self-update.md)
possible with zero runtime dependencies, and it is why we did not simply keep
`electron-builder` for its `electron-updater` integration.

## Considered options

**Where the release is built.** Building on the developer's Mac and uploading by
hand was rejected in favour of GitHub Actions cross-building on Linux. The
Mac-local option is usually argued for on trust grounds, but the argument does
not survive contact with the specifics: `pnpm install` already runs on that Mac
either way, so the `postinstall` exposure is identical, and the credential
sitting there is a full `gh` login — strictly more powerful than a job-scoped
`GITHUB_TOKEN`. CI's genuine added risk is third-party actions and an
over-broad trigger, and both are configuration problems.

Building on `windows-latest` was rejected as unnecessary: only the delivered
release must run on Windows, not the build.

**Squirrel.Windows** was rejected because `electron-winstaller` requires mono
and Wine on macOS, which defeats the point of cross-building.

## Consequences

- CI must run `workflow_dispatch` only, pin every third-party action to a full
  commit SHA, grant `contents: write` on the release job and nothing anywhere
  else, and install with a frozen lockfile. These are load-bearing, not
  hygiene — the release machine publishes artifacts that installations pick up
  without a human in the loop.
- The build cannot smoke-test its own output: a Linux runner cannot launch a
  Windows exe. "It built" does not mean "it runs".
- Mac packaging is dropped entirely. macOS remains a development environment
  (`pnpm dev`), not a target.
- Windows x64 only.
- Releases are unsigned. Every user meets a SmartScreen warning on first run and
  must click through it. A certificate would have to live wherever the build
  runs, which would reopen the build-location decision above.
