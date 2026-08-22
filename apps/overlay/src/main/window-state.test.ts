import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRestoredBounds, resizeWithinWorkArea } from './window-state';

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const MINIMUM_SIZE = { width: 240, height: 180 };

test('restores a saved visible overlay size and position', () => {
  assert.deepEqual(
    normalizeRestoredBounds({ x: 1500, y: 600, width: 364, height: 338 }, [PRIMARY], MINIMUM_SIZE),
    { x: 1500, y: 600, width: 364, height: 338 }
  );
});

test('re-homes a saved overlay that is outside the current displays', () => {
  assert.deepEqual(
    normalizeRestoredBounds({ x: 2500, y: 1200, width: 500, height: 400 }, [PRIMARY], MINIMUM_SIZE),
    { x: 1420, y: 640, width: 500, height: 400 }
  );
});

test('falls back to configured dimensions when saved bounds are invalid', () => {
  assert.deepEqual(
    normalizeRestoredBounds({ x: Number.NaN, y: 10, width: 0, height: 200 }, [PRIMARY], MINIMUM_SIZE),
    null
  );
});

test('keeps an interactive resize inside the remaining display work area', () => {
  assert.deepEqual(
    resizeWithinWorkArea(
      { x: 1500, y: 700, width: 364, height: 338 },
      { width: 364, height: 338 },
      { width: 900, height: 900 },
      PRIMARY,
      MINIMUM_SIZE
    ),
    { width: 420, height: 340 }
  );
});
