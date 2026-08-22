import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = await readFile(path.join(appRoot, 'scripts', 'Last Epoch Overlay.vbs'), 'utf8');

/**
 * WMI monikers are `winmgmts:[\\server\]namespace\path`. VBScript has no
 * backslash escape, so a moniker written with C-style `\\` separators reaches
 * WMI with an empty path segment and the whole call fails with
 * 0x80041021 (WBEM_E_INVALID_SYNTAX) -- on every machine, every time.
 */
function namespaceSegments(moniker) {
  const withoutServer = moniker.replace(/^\\\\[^\\]+\\/, '');
  return withoutServer.split('\\');
}

test('every WMI moniker in the launcher is well-formed', () => {
  const monikers = [...launcher.matchAll(/GetObject\("winmgmts:([^"]*)"\)/g)].map(([, moniker]) => moniker);

  assert.ok(monikers.length > 0, 'expected the launcher to reach WMI');
  for (const moniker of monikers) {
    assert.deepEqual(
      namespaceSegments(moniker).filter((segment) => segment === ''),
      [],
      `moniker "winmgmts:${moniker}" has an empty namespace segment`
    );
  }
});
