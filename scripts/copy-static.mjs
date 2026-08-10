// tsc only emits JS, so the renderer's HTML and CSS need copying alongside it.
// Kept as a tiny node script rather than a dependency -- it is 15 lines and
// works the same on Windows and macOS.

import { readdir, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'src', 'renderer');
const to = path.join(root, 'build', 'renderer');
const COPY = new Set(['.html', '.css', '.png', '.svg', '.woff2']);

await mkdir(to, { recursive: true });

const entries = await readdir(from, { withFileTypes: true });
let copied = 0;

for (const entry of entries) {
  if (!entry.isFile() || !COPY.has(path.extname(entry.name))) continue;
  await copyFile(path.join(from, entry.name), path.join(to, entry.name));
  copied += 1;
}

console.log(`[copy-static] ${copied} file(s) -> build/renderer`);
