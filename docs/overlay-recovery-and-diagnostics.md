# Overlay recovery and diagnostics

## Recover a local overlay

Press `Alt+Shift+O` to enter recovery mode. The overlay stops passing mouse
input through to the game and shows its whole boundary.

- Drag the strip labelled "Drag here to move overlay" to place it.
- Drag the bottom-right target labelled "Drag corner to resize" to change its
  size.
- Select "Return to click-through" before playing. The controls disappear and
  mouse clicks again go to the game.

The main process saves the window bounds after a move or resize. On the next
start it restores the saved size and position. If displays, their DPI, or the
taskbar layout changed, it clamps the saved bounds into a current display work
area so recovery mode remains visible.

## Pixel contract

`BrowserWindow` bounds use Electron device-independent pixels. The outer
renderer measures `#content-box` in CSS pixels and reports those values as
`TargetProfile.contentBox`. A publication must fit that CSS-pixel box.

`TargetProfile.devicePixelRatio` maps that CSS box to physical pixels. The
reported screenshot capacity is:

```text
width  = round(contentBox.width  × devicePixelRatio)
height = round(contentBox.height × devicePixelRatio)
```

This is a capacity report, not a screenshot capture feature. Check the target
profile and mailbox render status after every resize. Overflow-free status
only confirms layout. Directly view the physical display before accepting an
apparent-scale result.

## `gaming-pc` diagnostic path

Do not add an overlay, mailbox, or public endpoint for screen capture or
remote control. The preferred first path is an authenticated Tailnet RDP
session. Use it only when the operator starts it and remains present. The host
needs a Windows edition that can host Remote Desktop, Network Level
Authentication, and a firewall rule limited to the Tailnet interface or
Tailnet source range. Do not expose TCP 3389 on a public interface.

RDP is acceptable only if this live test keeps the same console session,
physical display resolution, Windows display scale, GPU path, and visible
overlay that the operator sees. Standard RDP may create or replace the console
session. If it does, it cannot diagnose physical apparent scale. Stop and use
an operator-initiated, same-console screen-share session instead. That is the
selected fallback. The operator must be able to see the session and revoke it.

For an RDP attempt, the operator enables the restricted firewall rule and RDP
only for the agreed session, starts the connection, and watches the physical
display. At the end, the operator disconnects the client, disables RDP and the
temporary firewall rule, and confirms that the local console still has the
expected display scale and overlay. RDP can permit unattended access while it
is enabled, so this lifecycle is required. The overlay does not enable RDP,
remote control, or background capture itself.

For each diagnostic session, record the following in the issue or PR before
calling the result verified:

1. Windows display scale and physical display resolution on `gaming-pc`.
2. The overlay profile: `contentBox`, `devicePixelRatio`, and calculated
   screenshot dimensions.
3. Current and restored window bounds after one recovery-mode resize and
   restart.
4. The published revision id plus mailbox render status, including overflow.
5. What the operator and the remote observer saw on the physical display.

If the calculated physical dimensions, observed bounds, and apparent scale
disagree, attach those numbers and fix the demonstrated cause. Do not guess at
a DPI correction from mailbox overflow alone.
