import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ipcMain = new EventEmitter();
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { ipcMain } } as NodeModule;
const { RevisionDelivery } = require('./revision-delivery') as typeof import('./revision-delivery');

const PROFILE = {
  protocolVersion: 1,
  version: 1,
  contentBox: { width: 800, height: 480 },
  devicePixelRatio: 1,
  screenshot: { width: 800, height: 480 },
  preferredIconSize: { min: 16, max: 64 },
  minimumTextSize: 12,
  background: { opaque: false },
  features: [],
};

const FIRST = {
  protocolVersion: 1 as const,
  id: 'rev-001',
  channel: 'main',
  profileVersion: 1,
  html: '<p>first</p>',
  assetIds: [],
  title: 'First',
  description: null,
};

const MISSING_ASSET = 'a'.repeat(64);
const CANDIDATE = { ...FIRST, id: 'rev-002', html: `<img src="asset:${MISSING_ASSET}">`, assetIds: [MISSING_ASSET] };
const STAGE_FAILURE = { ...FIRST, id: 'rev-003', html: '<img src="asset:broken">' };

test('keeps the committed revision visible when candidate asset fetch or renderer staging fails', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'overlay-revision-delivery-'));
  let candidate: 'initial' | 'missing' | 'stage-failure' = 'initial';
  let missingAssetRequested = false;
  let stageRejected = false;
  let visibleRevision = '';
  const committed: string[] = [];
  const attempted = new Map<string, string>();
  const webContents = {
    send(event: string, ...args: unknown[]) {
      if (event === 'revision:stage') {
        const command = args[0] as { attemptId: string; revision: { id: string } };
        attempted.set(command.attemptId, command.revision.id);
        if (command.revision.id === STAGE_FAILURE.id) {
          stageRejected = true;
          return queueMicrotask(() => ipcMain.emit('revision:stage-result', { sender: webContents }, {
            attemptId: command.attemptId,
            revisionId: command.revision.id,
            staged: false,
            error: 'renderer could not decode the staged image',
          }));
        }
        queueMicrotask(() => ipcMain.emit('revision:stage-result', { sender: webContents }, {
          attemptId: command.attemptId,
          revisionId: command.revision.id,
          staged: true,
          metrics: { width: 800, height: 480, scrollWidth: 800, scrollHeight: 480 },
        }));
      }
      if (event === 'revision:commit') {
        const attemptId = args[0] as string;
        const revisionId = attempted.get(attemptId)!;
        visibleRevision = revisionId;
        committed.push(revisionId);
        queueMicrotask(() => ipcMain.emit('revision:commit-result', { sender: webContents }, {
          attemptId,
          revisionId,
          activated: true,
          metrics: { width: 800, height: 480, scrollWidth: 800, scrollHeight: 480 },
        }));
      }
    },
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/profile')) return json(PROFILE);
    if (url.pathname.endsWith('/events')) return new Response(new ReadableStream(), { status: 200 });
    if (url.pathname.endsWith('/revisions/current')) return json(candidate === 'missing' ? CANDIDATE : candidate === 'stage-failure' ? STAGE_FAILURE : FIRST);
    if (url.pathname.includes(`/assets/${MISSING_ASSET}`)) {
      missingAssetRequested = true;
      return json({ protocolVersion: 1, code: 'asset_not_found', message: 'missing' }, 404);
    }
    return json({ protocolVersion: 1 });
  };
  console.warn = () => undefined;

  const delivery = new RevisionDelivery({ webContents, isDestroyed: () => false } as never, userDataDir);
  try {
    delivery.start({ mailboxUrl: 'http://mailbox.test', clientName: 'test', targetId: 'target-1', secret: 'secret', channel: 'main' });
    await eventually(() => visibleRevision === FIRST.id);
    candidate = 'missing';
    delivery.refresh();
    await eventually(() => missingAssetRequested);
    candidate = 'stage-failure';
    delivery.refresh();
    await eventually(() => stageRejected);
    assert.ok(committed.every((revisionId) => revisionId === FIRST.id));
    assert.equal(visibleRevision, FIRST.id);
  } finally {
    delivery.stop();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for delivery');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
