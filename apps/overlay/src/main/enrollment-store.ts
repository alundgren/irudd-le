import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * What survives an overlay restart: which mailbox, under what client name,
 * as which target id/secret, and (once paired) which channel. `channel`
 * stays `null` while pending -- see enrollment.ts for the heartbeat loop
 * that discovers pairing.
 */
export interface EnrollmentState {
  mailboxUrl: string;
  clientName: string;
  targetId: string;
  secret: string;
  channel: string | null;
}

const FILE_NAME = 'enrollment.json';

export function enrollmentFilePath(userDataDir: string): string {
  return path.join(userDataDir, FILE_NAME);
}

export function loadEnrollment(userDataDir: string): EnrollmentState | null {
  const file = enrollmentFilePath(userDataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isEnrollmentState(parsed) ? parsed : null;
  } catch {
    // A corrupt local file must never crash the overlay -- it just falls
    // back to "not enrolled" and the first-run screen reappears.
    return null;
  }
}

export function saveEnrollment(userDataDir: string, state: EnrollmentState): void {
  const file = enrollmentFilePath(userDataDir);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, file); // same filesystem, so this is atomic
}

export function clearEnrollment(userDataDir: string): void {
  rmSync(enrollmentFilePath(userDataDir), { force: true });
}

function isEnrollmentState(value: unknown): value is EnrollmentState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.mailboxUrl === 'string' &&
    typeof v.clientName === 'string' &&
    typeof v.targetId === 'string' &&
    typeof v.secret === 'string' &&
    (v.channel === null || typeof v.channel === 'string')
  );
}
