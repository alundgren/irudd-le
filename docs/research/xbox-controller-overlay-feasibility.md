# Xbox controller interaction while Last Epoch keeps input

**Decision:** feasible on Windows. Start with a no-dependency renderer
prototype using the web Gamepad API, while keeping Last Epoch focused. If that
specific Windows/game combination does not provide readings to Electron in the
background, use a narrow Windows-native GameInput bridge. In either version,
interpret the controller as overlay commands rather than focusing the overlay
or turning controller actions into mouse input.

This note was researched on 2026-08-10 against Electron, Microsoft, and W3C
primary documentation. No application code was changed.

## What the current overlay can already do

- `BrowserWindow.setIgnoreMouseEvents(true, { forward: true })` is correctly
  used for click-through. It makes a window ignore *mouse* events; `forward`
  only forwards mouse-move messages to Chromium. It says nothing about gamepad
  input. [Electron: `setIgnoreMouseEvents`](https://www.electronjs.org/docs/latest/api/browser-window#winsetignoremouseeventsignore-options)
- Electron's `globalShortcut` is explicitly a **global keyboard shortcut**
  facility. It remains a good, reliable escape hatch for `Alt+Shift+O`, but
  cannot bind an Xbox button. [Electron: `globalShortcut`](https://www.electronjs.org/docs/latest/api/global-shortcut)
- Moving the window needs no special Windows window hook: Electron exposes
  `win.setPosition(x, y)`. A controller move mode can convert left-stick values
  into pixel deltas and invoke that from the main process.
  [Electron: `setPosition`](https://www.electronjs.org/docs/latest/api/browser-window#winsetpositionx-y-animate)

The important project-specific issue is that `InteractionMode.apply(true)`
currently calls `win.focus()`. On Windows, XInput is automatically
enabled/disabled according to application-window focus; moving focus from Last
Epoch to the overlay is therefore contrary to the desired experience.
[Microsoft: `XInputEnable` remarks](https://learn.microsoft.com/en-us/windows/win32/api/xinput/nf-xinput-xinputenable)

## Viable input approaches

| Approach | Works while Last Epoch is focused? | Suitability |
| --- | --- | --- |
| **Renderer `navigator.getGamepads()`** | **Likely; verify on the actual PC** | Best first prototype: the standards API exposes buttons/axes to the renderer and specifies no exclusive capture. Chromium's Windows gamepad implementation contains both XInput and Windows.Gaming.Input data fetchers and its Gamepad service has multiple consumers. It is not an Electron promise, so test it with Last Epoch focused. [W3C Gamepad API](https://www.w3.org/TR/gamepad/), [Chromium gamepad implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/device/gamepad/), [Chromium Gamepad service](https://chromium.googlesource.com/chromium/src/+/9d0e9866426d0bb126d54903b77dc99d6ea2855e/device/gamepad/gamepad_service.h) |
| XInput in a native add-on | Uncertain / not preferred | `XInputGetState` reads an Xbox controller state, but Windows 10+ automatically enables/disables game-controller input based on window focus. [Microsoft: `XInputGetState`](https://learn.microsoft.com/en-us/windows/win32/api/xinput/nf-xinput-xinputgetstate), [Microsoft: `XInputEnable`](https://learn.microsoft.com/en-us/windows/win32/api/xinput/nf-xinput-xinputenable) |
| **GameInput v2 in a native add-on** | **Yes, by opt-in** | Recommended. `SetFocusPolicy(GameInputEnableBackgroundInput)` requests input even when the overlay is not focused. [Microsoft: focus policy](https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/input/gameinput-v2/interfaces/igameinput/methods/igameinput_setfocuspolicy-v2), [Microsoft: `GameInputEnableBackgroundInput`](https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/input/gameinput-v0/enums/gameinputfocuspolicy-v0) |
| Raw Input (`RIDEV_INPUTSINK`) in a native add-on | Yes, for matching HID collections | Valid fallback/prototype path. Windows documents background `WM_INPUT` delivery after an `RIDEV_INPUTSINK` registration, but raw reports require device-specific parsing/mapping. [Microsoft: Raw Input overview](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-raw-input) |

The web prototype needs two allowances: the document must be fully active and
the Gamepad API deliberately returns no devices until it observes a physical
gamepad gesture. [W3C: `getGamepads()`](https://www.w3.org/TR/gamepad/#dom-navigator-getgamepads)

GameInput is the better native fallback for an Xbox controller: it offers
fixed-format gamepad readings and polling/callback APIs, instead of raw HID
arrays. [Microsoft: GameInput readings](https://learn.microsoft.com/en-us/xbox/gdk/docs/features/common/input/overviews/input-readings), [Microsoft: `GameInputCreate`](https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/input/gameinput/functions/gameinputcreate)

### Important limitation: read, not intercept

`GameInputEnableBackgroundInput` gives the overlay a background copy of input;
it does not make the input private to the overlay. The focused game continues
to receive its own input. Conversely, a game using GameInput's
`ExclusiveForegroundInput` policy can prevent other GameInput processes from
seeing the input it receives. That makes coexistence an integration behavior to
test with Last Epoch, not an unconditional platform guarantee.
[Microsoft: GameInput focus policy](https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/input/gameinput-v0/enums/gameinputfocuspolicy-v0)

Therefore, a normal background-read implementation cannot make `A` activate an
overlay button *without* Last Epoch also seeing `A`. Blocking/remapping the
physical controller and forwarding a virtual controller to the game is a
materially different, much riskier product (and outside this overlay's
no-hooking/no-injection approach).

## Recommended interaction design

1. Keep `Alt+Shift+O` as the universal keyboard escape hatch. On Windows,
   toggling interactive mouse hit-testing must **not** call `win.focus()`;
   `showInactive()` establishes the desired non-activating behavior when the
   window is shown. To guarantee that a later mouse click cannot activate the
   overlay, make the Windows controller mode window non-focusable with
   `win.setFocusable(false)`. Electron supports that on Windows (and makes it
   skip the taskbar there). This deliberately gives up keyboard text entry in
   that mode, so retain the current focusable interactive mode as a separate
   desktop/keyboard mode. [Electron: `setFocusable`](https://www.electronjs.org/docs/latest/api/browser-window#winsetfocusablefocusable), [Electron: `focusable`](https://www.electronjs.org/docs/latest/api/base-window#new-basewindowoptions)
2. In the renderer, first poll `navigator.getGamepads()` (with edge detection,
   dead zones, and key-repeat timing) and turn raw buttons/axes into commands.
   It needs no extra runtime code. If the real-PC test fails while Last Epoch
   is foreground, replace only this reader with a Windows-only N-API GameInput
   bridge in the **main process**, initialized once with background-input
   policy. It can poll at 30–60 Hz or use a reading callback and publish the
   same normalized commands over the existing IPC boundary.
   [Microsoft: callbacks](https://learn.microsoft.com/en-us/gaming/gdk/docs/features/common/input/advanced/input-callbacks)
3. Treat the controller as a small command surface, not as a virtual mouse:
   D-pad cycles overlay focus, `A` invokes the selected overlay action,
   shoulders change tabs, and a deliberate chord toggles **move mode**. In move
   mode, the left stick calls `win.setPosition`; the renderer only receives a
   status/preview command. This works with no overlay window focus.
4. Require an explicit hold/chord for overlay navigation and move mode, and
   choose bindings configurable by the player. Those same physical inputs still
   reach the game, so the default should be deliberately hard to invoke during
   play. Keep a keyboard shortcut that exits move/overlay-control mode.
5. Expose this as an experimental Windows feature and report when the native
   bridge cannot obtain readings; a game that elects exclusive GameInput
   foreground input may make it unavailable.

This design satisfies the primary goal: the overlay can remain mouse
interactive while Last Epoch retains focus and controller gameplay. It does
not promise conflict-free reuse of every controller button; that would require
interception rather than observation.

## Smallest useful Windows prototype

Build a disposable Windows test with only these behaviors; begin entirely in
the renderer, then add the native bridge only if the first test fails:

1. Render connection state and log D-pad/A/left-stick changes from
   `navigator.getGamepads()` while Last Epoch is
   the foreground window and the overlay is visible but never focused.
2. With mouse hit-testing enabled, repeat that check with the overlay set
   non-focusable and click one overlay control. Verify that the click works
   without activating the overlay or disrupting controller gameplay.
3. Map a held chord + left stick to `win.setPosition` and verify that Last
   Epoch remains foreground and accepts its normal controller input.
4. Repeat with the exact Bluetooth Xbox controller and the release build of
   Last Epoch. Test both borderless-windowed mode and the actual display setup.
5. Only on failure, repeat steps 1–4 with GameInput initialized using
   `GameInputEnableBackgroundInput`.

The first three steps answer the main product-risk question: whether Electron's
renderer can observe the controller while Last Epoch is foreground on this
machine. If only GameInput fails because Last Epoch opts into foreground
exclusivity, evaluate the Raw Input fallback before considering any
interception design.

## Delivery implications

GameInput v1+ is supplied for PC through Microsoft.GameInput; Microsoft says
the redistributable should be included with non-GDK PC applications that use
it. [Microsoft: GameInput for PC and NuGet](https://learn.microsoft.com/en-us/gaming/gdk/docs/features/common/input/overviews/input-nuget)

A Node native module must also be built for Electron's ABI, not ordinary Node's
ABI, and rebuilt when Electron changes. It needs to be shipped outside the
app's ASAR (as an unpacked `.node` file) and built in the Windows x64 release
pipeline. [Electron: Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)

That packaging work is real but bounded. It is preferable to native controller
remapping because it preserves the overlay's current security boundary:
renderer code still has no Node access, and the native input code remains a
narrow main-process service.
