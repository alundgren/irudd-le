import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { screen, type BrowserWindow } from 'electron';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkArea extends WindowBounds {}

const STATE_FILE = 'overlay-window.json';
/**
 * BrowserWindow coordinates are Electron device-independent pixels (DIPs).
 * Restore the last visible bounds, but never let a changed monitor layout hide
 * the recovery controls off screen.
 */
export function normalizeRestoredBounds(
  saved: unknown,
  workAreas: readonly WorkArea[],
  minimumSize: Pick<WindowBounds, 'width' | 'height'>
): WindowBounds | null {
  if (!isBounds(saved) || workAreas.length === 0) return null;

  const display = workAreas.reduce((best, area) =>
    intersectionArea(saved, area) > intersectionArea(saved, best) ? area : best
  );
  const width = Math.min(saved.width, display.width);
  const height = Math.min(saved.height, display.height);
  if (width < minimumSize.width || height < minimumSize.height) return null;

  return {
    x: clamp(saved.x, display.x, display.x + display.width - width),
    y: clamp(saved.y, display.y, display.y + display.height - height),
    width,
    height,
  };
}

export function loadOverlayBounds(
  userDataDir: string,
  minimumSize: Pick<WindowBounds, 'width' | 'height'>
): WindowBounds | null {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(stateFilePath(userDataDir), 'utf8'));
  } catch {
    return null;
  }
  return normalizeRestoredBounds(saved, screen.getAllDisplays().map((display) => display.workArea), minimumSize);
}

/** Save only main-process observations. Renderer code never supplies bounds. */
export function persistOverlayBounds(userDataDir: string, win: BrowserWindow): void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const persist = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    const filePath = stateFilePath(userDataDir);
    const temporaryPath = `${filePath}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(win.getBounds()), 'utf8');
      renameSync(temporaryPath, filePath);
    } catch (error: unknown) {
      console.warn('[overlay] could not persist window bounds:', error);
    }
  };
  const schedule = (): void => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      persist();
    }, 150);
  };
  const flush = (): void => {
    if (pending) clearTimeout(pending);
    pending = null;
    persist();
  };
  win.on('move', schedule);
  win.on('resize', schedule);
  win.once('close', flush);
}

/** Clamp a resize to the part of the work area available to the current window. */
export function resizeWithinWorkArea(
  current: WindowBounds,
  start: Pick<WindowBounds, 'width' | 'height'>,
  delta: Pick<WindowBounds, 'width' | 'height'>,
  area: WorkArea,
  minimumSize: Pick<WindowBounds, 'width' | 'height'>
): Pick<WindowBounds, 'width' | 'height'> {
  const maximumWidth = Math.max(minimumSize.width, Math.min(area.width, area.x + area.width - current.x));
  const maximumHeight = Math.max(minimumSize.height, Math.min(area.height, area.y + area.height - current.y));
  return {
    width: Math.round(clamp(start.width + delta.width, minimumSize.width, maximumWidth)),
    height: Math.round(clamp(start.height + delta.height, minimumSize.height, maximumHeight)),
  };
}

function stateFilePath(userDataDir: string): string {
  return path.join(userDataDir, STATE_FILE);
}

function isBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== 'object') return false;
  const bounds = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((key) => Number.isInteger(bounds[key])) &&
    Number(bounds.width) > 0 && Number(bounds.height) > 0;
}

function intersectionArea(a: WindowBounds, b: WorkArea): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
