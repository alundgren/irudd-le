# gameinput-bridge

Windows-only N-API addon backing issue #18. Reads the Xbox controller through
Microsoft's GameInput API with `GameInputEnableBackgroundInput`, so the
overlay gets live readings while Last Epoch (not the overlay) keeps Windows
focus. See `docs/research/xbox-controller-overlay-feasibility.md` for the
design and `src/main/controller-bridge.ts` for how the main process loads
this.

This has never been compiled -- there is no Windows machine, MSVC toolchain,
or GameInput SDK available in the environment that wrote it. `src/gameinput_bridge.cc`
is written against the documented v0 GameInput surface but its exact
struct/enum names need to be checked against the real header the first time
this builds. Expect to fix compile errors on the first Windows build.

## One-time setup (on the Windows PC)

1. Install "Desktop development with C++" via the Visual Studio Build Tools
   installer (or Visual Studio itself). This gives you MSVC and the Windows
   SDK that `node-gyp` needs.
2. Install Python 3 (node-gyp needs it) and `node-gyp` globally:
   `npm install -g node-gyp`.
3. Get the GameInput redistributable headers/lib. Easiest path: create a
   throwaway C++ or .NET project in Visual Studio, add the `Microsoft.GameInput`
   NuGet package to it, then copy the two things you need out of that
   package's `native` folder into this directory (not committed to git --
   they're a third-party binary):
   - `GameInput.h` (and anything it `#include`s) -> `vendor/gameinput/include/`
   - `GameInput.lib` (x64) -> `vendor/gameinput/lib/x64/`

## Build

From this directory, on the Windows PC:

```
pnpm ls electron          # from the repo root, get the exact installed version, e.g. 43.3.0
node-gyp rebuild --target=<that electron version> --arch=x64 --dist-url=https://electronjs.org/headers
```

This targets Electron's ABI, not plain Node's -- required because this
addon is `require()`'d from Electron's main process. Re-run this any time
the `electron` devDependency version changes.

Output lands at `build/Release/gameinput_bridge.node`. `src/main/controller-bridge.ts`
loads it from exactly that path, relative to this directory -- don't move it.

## Test

1. `pnpm compile && pnpm start` from the repo root (or `pnpm start:interactive`).
2. Check the "Controller" panel the overlay shows in dev -- it should say
   `active` rather than `unavailable`/`error` once a gamepad is detected.
3. With Last Epoch focused and the overlay never clicked into focus, move the
   left stick and press D-pad/A -- the panel's log should update live.
4. Confirm Last Epoch keeps receiving its own controller input the whole
   time, with no click-back-to-restore-input step needed.
5. Record findings (controller model, Windows build, Last Epoch display mode,
   pass/fail per acceptance criterion) on issue #18.

## Known gaps (left for later, not blocking the prototype)

- `poll()` is synchronous request/response, called from a `setInterval` in
  `controller-bridge.ts` -- fine at 30-60 Hz, but a reading-callback design
  (`RegisterReadingCallback`) would be more idiomatic GameInput usage.
- Packaging: `scripts/package-win.mjs` copies `build/Release/gameinput_bridge.node`
  into the release zip, unpacked from the asar, *if that file exists* at
  package time -- it skips silently otherwise. Rebuild this addon before
  cutting a release once the bridge is proven out.
