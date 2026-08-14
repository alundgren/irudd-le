import { rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await rename(path.join(root, 'build', 'esm', 'index.js'), path.join(root, 'build', 'esm', 'index.mjs'));
