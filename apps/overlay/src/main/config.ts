import { PROTOCOL_VERSION, type ProtocolVersion } from '@irudd-le/protocol';

/**
 * All the knobs you are likely to want to turn live here.
 * Nothing else in the app hardcodes size, position or shortcuts.
 */

export type Corner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

export interface OverlayConfig {
  protocolVersion: ProtocolVersion;
  window: {
    width: number;
    height: number;
    corner: Corner;
    /** Gap in pixels between the overlay and the screen edges. */
    margin: number;
    /** Handy while developing; you may want false once you settle on a size. */
    resizable: boolean;
  };
  shortcuts: OverlayShortcuts;
  /** false = overlay starts click-through (mouse goes to the game). */
  startInteractive: boolean;
  /**
   * macOS only. true keeps the overlay out of the Dock and Cmd+Tab, which
   * feels more like an overlay -- but then the quit shortcut is your only way
   * out. Left off by default so quitting is never surprising.
   */
  hideDockIcon: boolean;
  enrollment: {
    /** How often a pending or paired target reports its live profile. */
    heartbeatIntervalMs: number;
    /**
     * The static parts of a `TargetProfile` (see @irudd-le/protocol): this
     * content shell's own capabilities, not something measured per-session.
     * `contentBox`, `devicePixelRatio` and `screenshot` are measured live
     * from the renderer instead -- see enrollment.ts.
     */
    preferredIconSize: { min: number; max: number };
    minimumTextSize: number;
    features: string[];
  };
}

export const config: OverlayConfig = {
  protocolVersion: PROTOCOL_VERSION,
  window: {
    width: 360,
    height: 480,
    corner: 'top-right',
    margin: 16,
    resizable: true,
  },

  shortcuts: {
    /** Click-through <-> interactive. */
    toggleInteractive: 'Alt+Shift+O',
    /** Hide/show the overlay entirely. */
    toggleVisibility: 'Alt+Shift+H',
    /** Frameless windows have no close button, so we need this. */
    quit: 'Alt+Shift+Q',
  },

  startInteractive: false,
  hideDockIcon: false,

  enrollment: {
    heartbeatIntervalMs: 20_000,
    preferredIconSize: { min: 16, max: 48 },
    minimumTextSize: 12,
    features: [],
  },
};
