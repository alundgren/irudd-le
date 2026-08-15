import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearEnrollment, enrollmentFilePath, loadEnrollment, saveEnrollment, type EnrollmentState } from './enrollment-store';

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlay-enrollment-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STATE: EnrollmentState = {
  mailboxUrl: 'https://mailbox.example.com',
  clientName: 'Living room PC',
  targetId: 'target-1',
  secret: 'tgt_abc123',
  channel: null,
};

test('returns null when nothing has been saved yet', () => {
  withTempDir((dir) => {
    assert.equal(loadEnrollment(dir), null);
  });
});

test('round-trips a saved enrollment, including the paired channel once set', () => {
  withTempDir((dir) => {
    saveEnrollment(dir, STATE);
    assert.deepEqual(loadEnrollment(dir), STATE);

    const paired: EnrollmentState = { ...STATE, channel: 'main' };
    saveEnrollment(dir, paired);
    assert.deepEqual(loadEnrollment(dir), paired);
  });
});

test('re-enrollment clears the previous identity so the setup screen reappears', () => {
  withTempDir((dir) => {
    saveEnrollment(dir, STATE);
    clearEnrollment(dir);
    assert.equal(loadEnrollment(dir), null);
    // Clearing again (nothing there) must not throw.
    clearEnrollment(dir);
  });
});

test('falls back to unenrolled on a corrupt or malformed local file rather than crashing', () => {
  withTempDir((dir) => {
    writeFileSync(enrollmentFilePath(dir), 'not json', 'utf8');
    assert.equal(loadEnrollment(dir), null);

    writeFileSync(enrollmentFilePath(dir), JSON.stringify({ mailboxUrl: 'x' }), 'utf8');
    assert.equal(loadEnrollment(dir), null);
  });
});
