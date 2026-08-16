import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const testArguments = process.argv.slice(2);
if (testArguments[0] === '--') testArguments.shift();
const [sourceTest, ...extraArguments] = testArguments;

if (!sourceTest || extraArguments.length > 0) {
  throw new Error('Pass exactly one source test-file path after --.');
}

const packageRoot = process.cwd();
const sourcePath = path.resolve(packageRoot, sourceTest);
const relativeSourcePath = path.relative(packageRoot, sourcePath);

if (relativeSourcePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSourcePath) || !existsSync(sourcePath)) {
  throw new Error(`Test file must exist within this package: ${sourceTest}`);
}

let command;
let argumentsForRunner;

if (relativeSourcePath.endsWith('.ts')) {
  if (!relativeSourcePath.startsWith(`src${path.sep}`)) {
    throw new Error(`Compiled TypeScript tests must be under src/: ${sourceTest}`);
  }

  const emittedTest = path.join(
    packageRoot,
    'build',
    relativeSourcePath.slice(`src${path.sep}`.length).replace(/\.ts$/, '.js')
  );
  command = process.execPath;
  argumentsForRunner = ['--test', emittedTest];
} else if (relativeSourcePath.endsWith('.mjs')) {
  command = process.execPath;
  argumentsForRunner = ['--test', sourcePath];
} else if (relativeSourcePath.endsWith('.cjs')) {
  command = 'xvfb-run';
  argumentsForRunner = ['-a', 'electron', '--no-sandbox', sourcePath];
} else {
  throw new Error(`Unsupported focused test file: ${sourceTest}`);
}

const result = spawnSync(command, argumentsForRunner, { cwd: packageRoot, stdio: 'inherit' });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
