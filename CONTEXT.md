# irudd-le

A transparent, always-on-top desktop overlay for Last Epoch. The player runs the
game on a Windows desktop that is screen-duplicated to a TV, so the overlay is
usually read from across the room rather than operated up close.

## Language

### The overlay

**Overlay**:
The always-on-top window that displays reference content beside the running
game.
_Avoid_: HUD, widget, panel

**Click-through**:
The overlay state in which mouse input passes to whatever is underneath.
_Avoid_: pass-through, transparent-to-input

**Interactive**:
The overlay state in which the overlay itself receives mouse and keyboard input.
_Avoid_: focused, active

**Couch distance**:
The operating assumption that the player is watching the TV without a mouse or
keyboard in reach. Anything the overlay requires a click for is unavailable at
couch distance.
_Avoid_: TV mode, lean-back

### Delivery

**Release**:
A published, versioned build of the overlay that a running installation can
discover and move to. Every release is a real version; there is no rolling or
mutable release.
_Avoid_: build, drop, tag

**Install root**:
The single directory on the player's machine that holds every installed version
of the overlay.
_Avoid_: install dir, app folder

**Version folder**:
One installed version inside the install root. Version folders are never
modified in place — a new version arrives as a new folder alongside the old
ones.
_Avoid_: install, copy

**Launcher**:
The one entry point inside the install root that the player starts. It resolves
which version folder is current and runs it, so that a pinned shortcut never
goes stale as versions come and go.
_Avoid_: stub, shim, bootstrapper

**Update check**:
The overlay asking whether a release newer than the running version exists.
_Avoid_: poll, ping, version check

**Self-update**:
The overlay acting on an update check without the player doing anything —
acquiring the newer release as a new version folder and restarting into it.
Self-update is the only update path, because the player is at couch distance.
_Avoid_: auto-update, upgrade
