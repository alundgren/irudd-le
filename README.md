# irudd-le — Last Epoch in-game overlay

A transparent, always-on-top desktop overlay for **Last Epoch**. It sits in a
screen corner showing your own reference content (starting with a build
planner), and stays click-through so it never steals mouse input from the game
— until you press a shortcut to interact with it.

This repo currently contains **v1**: the window, the click-through toggle, and a
placeholder content panel. See [Project intent](#project-intent) for where it is
going.

---

## Quick start

```bash
pnpm install     # also downloads the Electron binary (~120 MB, cached)
pnpm dev         # compile + launch, restarting on file changes
```

The overlay appears in the **top-right** corner, semi-transparent, and starts in
**click-through** mode — clicks go straight to whatever is underneath.

Press **`Alt+Shift+O`** to make it interactive, then scroll/click/type in it.
Press it again to go back to click-through.

| Shortcut | What it does |
| --- | --- |
| `Alt+Shift+O` | Toggle click-through ⇄ interactive |
| `Alt+Shift+H` | Hide / show the overlay |
| `Alt+Shift+Q` | Quit (the window is frameless, so there is no close button — though an `×` appears in the title bar while interactive) |

### Which mode am I in?

Two cues, both deliberately obvious:

- **Click-through** — grey dot, no border highlight, slightly faded, and the
  interactive-only controls (`×`, "Back to click-through") are hidden.
- **Interactive** — green glowing dot, amber border, full opacity, controls
  visible, label reads `INTERACTIVE`.

While interactive you can also **drag the title bar** to move the overlay.

### Other commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Compile, launch, and restart on any change under `src/` |
| `pnpm start` | Compile and launch once |
| `pnpm start:interactive` | Same, but boots straight into interactive mode |
| `pnpm compile` | TypeScript → `build/`, plus copy HTML/CSS |
| `pnpm typecheck` | Type-check both projects without emitting |
| `pnpm build` | Package the app (see [Building](#building)) |
| `pnpm clean` | Delete `build/` |

---

## Testing it without the game

Last Epoch — or any game — **must run in borderless windowed mode**. Exclusive
fullscreen hands the whole display to the game and *nothing* can draw above it.
This is a hard limit of the approach, not a bug.

For development you don't need the game at all: any large window (browser,
editor) makes a fine stand-in. Put it behind the overlay and check that clicks
land in it while in click-through mode.

---

## Configuration

Everything you're likely to change lives in **`src/main/config.ts`**:

```ts
window: {
  width: 360,
  height: 480,
  corner: 'top-right',   // or 'top-left' | 'bottom-right' | 'bottom-left'
  margin: 16,            // gap from the screen edges
  resizable: true,
},
shortcuts: {
  toggleInteractive: 'Alt+Shift+O',
  toggleVisibility: 'Alt+Shift+H',
  quit: 'Alt+Shift+Q',
},
startInteractive: false, // true = start interactive instead of click-through
hideDockIcon: false,     // macOS: hide from Dock and Cmd+Tab
```

Position is computed against the **work area** of the display the cursor is on,
so the overlay never lands under the menu bar or taskbar, and it follows you to
whichever monitor you launch it from.

Shortcut strings use [Electron accelerators](https://www.electronjs.org/docs/latest/api/accelerator).
If another app already owns your chosen combination, registration fails and the
app logs a warning naming the shortcut — it does not crash.

---

## Architecture

```
src/
├── main/                  # Node side: owns the window and all OS-level state
│   ├── index.ts           #   app lifecycle, global shortcuts
│   ├── config.ts          #   all tunable settings
│   ├── overlay-window.ts  #   BrowserWindow creation, corner positioning
│   ├── interaction.ts     #   click-through ⇄ interactive, single source of truth
│   └── ipc.ts             #   every channel the renderer can reach
├── preload/index.ts       # the ONLY bridge; contextBridge → window.overlay
├── renderer/              # the UI: plain HTML/CSS/TS, no framework
│   ├── index.html
│   ├── style.css
│   └── app.ts
└── shared/types.d.ts      # the contract shared by all three
```

The main/preload/renderer boundary is the seam v2 and v3 build on, so it is kept
strict:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- The renderer's tsconfig omits Node types entirely, so reaching for Node in the
  UI is a **compile error**, not a runtime surprise.
- IPC channels are namespaced `namespace:verb-noun` (`overlay:toggle-interactive`).
  v2 adds `ollama:*`, v3 adds `capture:*` — new module, new object on the
  preload bridge, nothing existing needs rewriting.
- Main verifies every IPC message came from the overlay window before acting.
- Interaction mode lives **only** in the main process. The renderer asks for it
  and is notified of changes; it never tracks its own copy, so the visual
  indicator cannot disagree with the actual OS-level click-through flag.

### Choices worth knowing

**TypeScript, compiled with plain `tsc`.** Two projects, because the two sides
are genuinely different environments: `tsconfig.node.json` (CommonJS + Node
types) for main/preload, `tsconfig.web.json` (ES modules + DOM types) for the
renderer. No bundler — for a framework-light UI it would add a build step and
config to debug without buying anything yet.

**Shared types as an ambient `.d.ts`.** `src/shared/types.d.ts` declares the IPC
payloads and the `window.overlay` API. Being ambient, it emits no JavaScript and
needs no imports, while `pnpm typecheck` still catches preload and renderer
drifting apart.

**pnpm.** `node-linker=hoisted` is set in `.npmrc` because electron-builder walks
`node_modules` directly and trips over pnpm's default symlinked layout.

**No framework in the UI.** Panels are plain DOM behind a tab strip, so adding a
chat panel (v2) or a live suggestions panel (v3) means adding a `<section>` — no
layout to fight. The `Ask` and `Vision` tabs are already there, disabled, as
placeholders.

**electron-builder** over Forge: less configuration for what we need (Windows
NSIS + portable from a few lines of `package.json`), and no plugin layer to
learn since there's no bundler to integrate.

---

## Building

```bash
pnpm build        # current platform
pnpm build:win    # Windows: NSIS installer + portable .exe
pnpm build:mac    # macOS: .dmg
```

Output lands in `dist/`. Config is the `build` block in `package.json`.

Note that `directories.buildResources` is set to `build-resources/`, because
electron-builder defaults it to `build/` — which is where our compiled
TypeScript goes.

### Status of each target

- **Windows (`pnpm build:win`) — not yet run.** The config is standard NSIS +
  portable, but this project has so far only been developed on macOS.
  Cross-building Windows from macOS needs Wine; build on Windows (or CI).
- **macOS (`pnpm build:mac`) — packages successfully, but the resulting `.app`
  does not launch on this machine.** It exits immediately with status 0. Known
  and understood so far:
  - It is **not** an app-code problem. Running the packaged bundle's own
    `app.asar` under the dev Electron binary works perfectly:
    ```bash
    env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
      "dist/mac-arm64/Last Epoch Overlay.app/Contents/Resources/app.asar"
    ```
  - The build is **ad-hoc signed** (`mac.identity: "-"`), since this machine has
    no Developer ID. The required hardened-runtime entitlements *are* applied —
    verify with `codesign -d --entitlements - "dist/mac-arm64/Last Epoch Overlay.app"`.
  - Next thing to try is signing with a real Developer ID identity (drop the
    `"identity": "-"` line) before digging further.

  Because macOS is only the development target here, **use `pnpm dev` or
  `pnpm start` on this machine** — those are fully working. Packaging matters for
  Windows, which is where the overlay is actually used.

There is deliberately **no auto-update and no telemetry**.

---

## macOS notes

macOS is the development/testing target here; Windows is where it actually gets
used. Every v1 behaviour was verified working on macOS (Apple silicon, Electron
43) when run via `pnpm dev` / `pnpm start`: transparency, always-on-top, corner
placement, both interaction modes and their indicators, scrolling and typing.
(The *packaged* `.app` is a separate, still-open issue — see
[Building](#building).) Some specifics:

- **Always-on-top level matters.** `setAlwaysOnTop(true, 'screen-saver')` plus
  `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` is what makes
  the overlay float above *other apps'* fullscreen windows and follow you across
  Spaces. The default level is not enough.
- **`backdrop-filter` cannot blur the desktop behind a transparent window** — it
  only blurs content inside the window. So readability comes from the background
  alpha in `style.css` (`--bg`) alone. If the overlay is hard to read over bright
  scenes, raise that alpha.
- **Resizing a transparent frameless window is finicky.** `resizable: true` is
  set and the window does resize, but the invisible edge grips are easy to miss.
  Setting the size in `config.ts` is the reliable route.
- **No window shadow** (`hasShadow: false`) — on a transparent window macOS
  draws it around the full rectangle, not the rounded content.
- `hideDockIcon: true` gives a more overlay-like feel, but then `Alt+Shift+Q` is
  your only way to quit. Off by default.

### Troubleshooting

- **`electron` exits instantly with no output** — an instance is already
  running; the single-instance lock is doing its job. It now logs a warning
  saying so. If you `kill -9` the app, the lock can be left behind stale; clear
  it with:
  ```bash
  rm -f ~/Library/Application\ Support/last-epoch-overlay/Singleton*
  ```
- **`electron --version` prints a Node version** — you have
  `ELECTRON_RUN_AS_NODE=1` in your environment, which makes Electron behave as
  plain Node. Launch with `env -u ELECTRON_RUN_AS_NODE …`.
- **`pnpm install` finished but Electron won't start** — the `postinstall` step
  (`scripts/ensure-electron.mjs`) fetches the Electron binary, which pnpm does
  not do on its own here. Run `node scripts/ensure-electron.mjs` to retry.
  Electron's own build script must stay allowed in `pnpm-workspace.yaml`.
- **A shortcut does nothing** — another app owns it. Check the console warning
  and change it in `src/main/config.ts`.

---

## Project intent

The long-term goal is an overlay that understands what you're doing in game.
Three independent stages:

- **v1 — window + static content (this repo, done).** Transparent, frameless,
  always-on-top window in a screen corner, click-through by default with a
  shortcut to interact. Holds static reference content; the placeholder stands
  in for a build planner.
- **v2 — local LLM chat (future).** Talk to a locally running
  [Ollama](https://ollama.com) instance at `http://localhost:11434` to ask
  questions or summarise a build. Architecturally just HTTP plus an
  `ollama:chat` IPC channel and a new panel behind the existing `Ask` tab.
- **v3 — screen awareness (future).** Periodically capture the screen (or a
  region) and feed it to a vision-capable local model, or OCR first, so the
  overlay reacts to what's on screen instead of being fed information by hand.
  Adds a `capture:*` namespace and the `Vision` panel.

v2 and v3 are independent — either can land first, and neither depends on the
other. Both depend on v1's window and IPC boundary, which is why that boundary
is strict.

### Non-goals

Deliberately out of scope, permanently:

- **No DirectX/render hooking, no injection into the game process, no reading or
  writing game memory.** This stays at the "separate OS window drawn on top"
  level: simpler, cross-platform, and far less likely to raise anti-cheat or ToS
  concerns.
- **No anti-cheat bypass, and no automation that acts in the game.** No input is
  ever injected into the game window. This is a read-and-inform tool, not a bot.
- **No telemetry, no analytics, no auto-update.** Local and simple.
