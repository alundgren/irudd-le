import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(appRoot, 'build'), { recursive: true });
await cp(path.join(appRoot, 'src', 'index.html'), path.join(appRoot, 'build', 'index.html'));
