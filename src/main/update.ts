import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, type BrowserWindow } from 'electron';

const LAUNCHER_NAME = 'Last Epoch Overlay.vbs';
const APP_EXE_NAME = 'Last Epoch Overlay.exe';
const UPDATE_INTERVAL_MS = 60_000;
const UPDATE_METADATA_URL =
  'https://github.com/alundgren/irudd-le/releases/latest/download/last-epoch-overlay-update.json';

interface ReleaseMetadata {
  version: string;
  sha256: string;
  url: string;
}

interface InstallRoot {
  root: string;
  launcher: string;
}

/**
 * Fetches and installs ordinary GitHub releases without touching the GitHub
 * API. The release metadata is deliberately small and immutable; its digest
 * authenticates the much larger zip before it reaches the install root.
 */
export class UpdateManager {
  private readonly win: BrowserWindow;
  private readonly install: InstallRoot | null;
  private timer: NodeJS.Timeout | null = null;
  private updating = false;
  private currentStatus: UpdateStatus = 'idle';

  constructor(win: BrowserWindow) {
    this.win = win;
    this.install = findInstallRoot();
  }

  state(): UpdateStatus {
    return this.currentStatus;
  }

  start(): void {
    if (!this.install) return;

    void this.check();
    this.timer = setInterval(() => void this.check(), UPDATE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private setStatus(status: UpdateStatus): void {
    this.currentStatus = status;
    if (!this.win.isDestroyed()) {
      this.win.webContents.send('update:status-changed', status);
    }
  }

  private async check(): Promise<void> {
    if (!this.install || this.updating) return;

    try {
      const metadata = await fetchMetadata();
      if (compareVersions(metadata.version, app.getVersion()) <= 0) return;

      this.updating = true;
      this.setStatus('downloading');
      await this.installRelease(metadata);
      restartThroughLauncher(this.install.launcher);
      app.quit();
    } catch (error: unknown) {
      // Update failures must never interrupt the overlay. The next interval
      // retries a transient network or release-publication failure.
      console.warn('[update] check failed:', error);
      this.updating = false;
      this.setStatus('idle');
    }
  }

  private async installRelease(metadata: ReleaseMetadata): Promise<void> {
    if (!this.install) return;

    const destination = path.join(this.install.root, metadata.version);
    if (existsSync(destination)) return;

    const suffix = `${process.pid}-${Date.now()}`;
    const downloadedZip = path.join(this.install.root, `.update-${suffix}.zip`);
    const staging = path.join(this.install.root, `.update-${suffix}`);

    try {
      const response = await fetch(metadata.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) {
        throw new Error(`download returned HTTP ${response.status}`);
      }

      await writeFile(downloadedZip, Buffer.from(await response.arrayBuffer()));
      const digest = await sha256(downloadedZip);
      if (digest !== metadata.sha256) {
        throw new Error('download SHA-256 does not match release metadata');
      }

      await mkdir(staging);
      await extractZip(downloadedZip, staging);

      const entries = await readdir(staging);
      const extracted = path.join(staging, metadata.version);
      if (
        entries.length !== 2 ||
        !entries.includes(metadata.version) ||
        !entries.includes(LAUNCHER_NAME) ||
        !(await isDirectory(extracted)) ||
        !existsSync(path.join(extracted, APP_EXE_NAME))
      ) {
        throw new Error('release zip does not contain the expected version folder');
      }

      // A concurrent invocation may have installed it while this process was
      // downloading. Either way, never replace an existing version folder.
      if (!existsSync(destination)) {
        await rename(extracted, destination);
      }
    } finally {
      await Promise.all([
        rm(downloadedZip, { force: true }),
        rm(staging, { recursive: true, force: true }),
      ]);
    }
  }
}

function findInstallRoot(): InstallRoot | null {
  if (!app.isPackaged || process.platform !== 'win32') return null;

  const versionFolder = path.dirname(process.execPath);
  const root = path.dirname(versionFolder);
  const launcher = path.join(root, LAUNCHER_NAME);

  if (
    path.basename(process.execPath) !== APP_EXE_NAME ||
    path.basename(versionFolder) !== app.getVersion() ||
    !existsSync(launcher)
  ) {
    return null;
  }

  return { root, launcher };
}

async function fetchMetadata(): Promise<ReleaseMetadata> {
  const response = await fetch(UPDATE_METADATA_URL, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`metadata returned HTTP ${response.status}`);

  return parseMetadata(await response.json());
}

function parseMetadata(value: unknown): ReleaseMetadata {
  if (!value || typeof value !== 'object') throw new Error('metadata is not an object');
  const record = value as Record<string, unknown>;
  const { version, sha256, url } = record;

  if (
    typeof version !== 'string' ||
    !isVersion(version) ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof url !== 'string'
  ) {
    throw new Error('metadata has an invalid shape');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('metadata contains an invalid download URL');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('metadata download URL must use HTTPS');
  }

  return { version, sha256, url };
}

function isVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

/** Supports the stable numeric version format used by package.json. */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);

  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function extractZip(zip: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const quoteForPowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${quoteForPowerShell(zip)} -DestinationPath ${quoteForPowerShell(destination)} -Force`,
      ],
      { windowsHide: true }
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Expand-Archive exited with code ${code ?? 'unknown'}`));
    });
  });
}

function restartThroughLauncher(launcher: string): void {
  const child = spawn('wscript.exe', [launcher, String(process.pid)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
