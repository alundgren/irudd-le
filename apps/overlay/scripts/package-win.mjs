// Packages the compiled overlay as a Windows x64 version folder, zipped.
//
// The zip's top level is the version folder plus its stable launcher, so
// installing is "unzip into the install root" and nothing else -- see
// docs/adr/0002-versioned-folders-and-self-update.md.
//
// We package a staging directory rather than the repo root; stage-app.mjs
// builds it and explains why.

import { rm, cp, rename, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { stageApp } from './stage-app.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(appRoot, 'dist');
const staging = path.join(dist, 'staging');
const out = path.join(dist, 'out');

// Packager reads the Electron version from the packaged dir's devDependencies,
// and the staging dir deliberately has none. Take it from what is installed.
const electronPkg = JSON.parse(
  await readFile(path.join(appRoot, 'node_modules', 'electron', 'package.json'), 'utf8')
);

await rm(dist, { recursive: true, force: true });

const pkg = await stageApp({ appRoot, staging });
const version = pkg.version;
const zipName = `last-epoch-overlay-${version}-win32-x64.zip`;

const [built] = await packager({
  dir: staging,
  out,
  platform: 'win32',
  arch: 'x64',
  electronVersion: electronPkg.version,
  appVersion: version,
  prune: false,
  overwrite: true,
  asar: true,
  win32metadata: {
    CompanyName: pkg.author,
    FileDescription: pkg.description,
  },
});

// Packager names the directory <productName>-win32-x64; the install root wants
// it named after the version, because "newest version folder wins" is how the
// launcher will resolve which one to start.
const versionFolder = path.join(out, version);
await rename(built, versionFolder);
await cp(
  path.join(appRoot, 'scripts', 'Last Epoch Overlay.vbs'),
  path.join(out, 'Last Epoch Overlay.vbs')
);

// `zip` ships with macOS and the Ubuntu runner image, so this stays
// dependency-free. -r recurse, -q quiet, -X drop extra file attributes.
const zipped = spawnSync('zip', ['-r', '-q', '-X', path.join(dist, zipName), version, 'Last Epoch Overlay.vbs'], {
  cwd: out,
  stdio: 'inherit',
});

if (zipped.status !== 0) {
  console.error('[package-win] zip failed');
  process.exit(1);
}

await rm(staging, { recursive: true, force: true });

console.log(`[package-win] dist/${zipName}`);
console.log(`[package-win] unzips to ${version}/Last Epoch Overlay.exe plus Last Epoch Overlay.vbs`);
