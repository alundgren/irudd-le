// Makes `pnpm install` reliably end with a usable Electron binary.
//
// The `electron` package normally downloads its ~120 MB binary from its own
// postinstall hook. That hook does not run under pnpm here (pnpm 11 does not
// expose a `scripts` field for the installed package), which leaves
// node_modules/electron without a `dist/`, and every `electron` command then
// fails in a confusing way.
//
// So we check, and run Electron's own installer ourselves if needed. Electron's
// installer handles the platform, the download and its shared cache, so this
// stays a few lines and no download logic is duplicated.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const pathTxt = path.join(electronDir, 'path.txt');

/** The installed binary, or null if it is missing or half-extracted. */
function binaryPath() {
  if (!existsSync(pathTxt)) return null;
  const relative = readFileSync(pathTxt, 'utf8').trim();
  const absolute = path.join(electronDir, 'dist', relative);
  return existsSync(absolute) ? absolute : null;
}

if (binaryPath()) {
  console.log('[ensure-electron] binary already present');
  process.exit(0);
}

const installer = path.join(electronDir, 'install.js');
if (!existsSync(installer)) {
  console.error('[ensure-electron] node_modules/electron is missing — run `pnpm install`');
  process.exit(1);
}

console.log('[ensure-electron] fetching the Electron binary (~120 MB, cached after this)…');
const result = spawnSync(process.execPath, [installer], {
  stdio: 'inherit',
  cwd: electronDir,
});

if (result.status !== 0 || !binaryPath()) {
  console.error(
    '[ensure-electron] failed. Try `node node_modules/electron/install.js` for the full error.'
  );
  process.exit(1);
}

console.log(`[ensure-electron] ready: ${path.relative(root, binaryPath())}`);
