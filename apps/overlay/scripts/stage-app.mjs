// Builds the directory that @electron/packager turns into a version folder.
//
// The staging dir is build/ plus a trimmed package.json, so packager never sees
// the repo's node_modules: no ignore patterns to keep in sync, no pruning, and
// pnpm's symlinked layout never enters the picture.
//
// The one thing it does need from node_modules is the app's runtime
// `dependencies`. Those are workspace packages (`@irudd-le/protocol`), and the
// compiled main process `require()`s them, so each is copied in as a plain
// node_modules entry -- resolvable by Node inside the asar without any symlink.

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const isTestFile = (source) => source.endsWith('.test.js') || source.endsWith('.test.d.ts');

/** Fields a packaged dependency needs; the rest (scripts, devDependencies) only confuse Node. */
const publishedFields = ['name', 'version', 'main', 'module', 'types', 'exports'];

async function stageDependency({ appRoot, staging, name }) {
  // Resolved through the app's own node_modules, so the staged copy is exactly
  // the version pnpm linked for this build.
  const source = path.join(appRoot, 'node_modules', ...name.split('/'));
  const target = path.join(staging, 'node_modules', ...name.split('/'));
  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));

  await mkdir(target, { recursive: true });
  await cp(path.join(source, 'build'), path.join(target, 'build'), {
    recursive: true,
    filter: (entry) => !isTestFile(entry),
  });
  await writeFile(
    path.join(target, 'package.json'),
    JSON.stringify(Object.fromEntries(publishedFields.filter((key) => key in pkg).map((key) => [key, pkg[key]])), null, 2) + '\n'
  );
}

/**
 * Populates `staging` with everything the packaged app runs from: the compiled
 * build/, a trimmed package.json, and the runtime dependencies of the app.
 */
export async function stageApp({ appRoot, staging }) {
  const pkg = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));

  await mkdir(staging, { recursive: true });

  // Excludes compiled `*.test.js` (src/main/*.test.ts) -- test.ts files live
  // alongside the modules they cover so tsc compiles them into build/main/
  // too, but they have no reason to ship inside a released version folder.
  await cp(path.join(appRoot, 'build'), path.join(staging, 'build'), {
    recursive: true,
    filter: (source) => !isTestFile(source),
  });

  await writeFile(
    path.join(staging, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        productName: 'Last Epoch Overlay',
        version: pkg.version,
        description: pkg.description,
        main: pkg.main,
        author: pkg.author,
        license: pkg.license,
      },
      null,
      2
    ) + '\n'
  );

  for (const name of Object.keys(pkg.dependencies ?? {})) {
    await stageDependency({ appRoot, staging, name });
  }

  return pkg;
}
