import { rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'build', 'esm', 'index.js');
const to = path.join(root, 'build', 'esm', 'index.mjs');

// Dependent packages build the protocol before their own typecheck/test, so two
// builds can race here. Renaming an already-renamed file is the expected
// outcome of losing that race, not a failure.
try {
  await rename(from, to);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await stat(to);
}
