import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  PUBLISHING_GUIDE,
  PUBLISHING_GUIDE_ASSET_ID_PLACEHOLDER,
  revisionSchema,
  type RenderStatusObservation,
} from '@irudd-le/protocol';
import { MailboxClient } from './client';
import { run, type CliIo } from './cli';

/**
 * A fresh agent follows the published guidance and nothing else. This fixture
 * executes the guide's own example workflow verbatim -- the same argv arrays
 * the CLI help prints -- against a mailbox stub, so the documented workflow
 * cannot drift away from the commands that actually work.
 */

const CHANNEL = { protocolVersion: 1, id: 'main', name: 'Main channel' };

const PROFILE = {
  protocolVersion: 1,
  version: 3,
  contentBox: { width: 1280, height: 720 },
  devicePixelRatio: 1,
  screenshot: { width: 1280, height: 720 },
  preferredIconSize: { min: 16, max: 32 },
  minimumTextSize: 14,
  background: { opaque: true },
  features: [],
};

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ASSET_ID = createHash('sha256').update(PNG_BYTES).digest('hex');

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The smallest mailbox that can answer every request the guided workflow makes. */
function mailboxStub() {
  const published: Array<Record<string, unknown>> = [];
  let renderStatus: RenderStatusObservation | null = null;

  const fetcher = async (input: URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    if (url.endsWith('/v1/channels/main')) return json(200, CHANNEL);
    if (url.endsWith('/v1/channels/main/profile')) return json(200, PROFILE);
    if (url.endsWith('/v1/channels/main/render-status')) {
      return renderStatus ? json(200, renderStatus) : json(404, { protocolVersion: 1, code: 'no_render_status', message: 'No observation yet' });
    }
    if (url.endsWith('/v1/channels/main/assets')) {
      assert.equal(init?.headers && (init.headers as Record<string, string>)['content-type'], 'image/png');
      return json(201, { protocolVersion: 1, id: ASSET_ID, contentType: 'image/png', byteLength: PNG_BYTES.length, sha256: ASSET_ID });
    }
    if (url.endsWith('/v1/channels/main/revisions/current')) {
      const revision = revisionSchema.parse(JSON.parse(String(init?.body)));
      published.push(revision as unknown as Record<string, unknown>);
      renderStatus = {
        protocolVersion: 1,
        targetId: 'target-1',
        attemptId: `attempt-${published.length}`,
        attemptStartedAt: 1000,
        profileVersion: revision.profileVersion,
        currentRevisionId: revision.id,
        candidateRevisionId: revision.id,
        rendered: { width: 1280, height: 720, scrollWidth: 1280, scrollHeight: 720 },
        overflow: { horizontal: false, vertical: false },
        activation: 'active',
        failureReason: null,
        observedAt: 2000,
        online: true,
      };
      return json(201, revision);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  return { fetcher, published };
}

test('a fresh agent can follow the published example workflow end to end', async () => {
  const { fetcher, published } = mailboxStub();
  const transcript: string[] = [];
  let stdout = '';
  let publishedDocument = '';

  const io: CliIo = {
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { throw new Error(`the guided workflow wrote to stderr: ${chunk}`); } },
    // The guide tells the agent to export the credential rather than pass it
    // as a flag, so no step in the workflow may carry --secret.
    env: { MAILBOX_SECRET: 'pub_secret' },
    readFile: async () => publishedDocument,
    readBinaryFile: async () => PNG_BYTES,
    createClient: (mailboxUrl, secret) => new MailboxClient(mailboxUrl, secret, fetcher, () => 'rev-guided'),
  };

  let uploadedAssetId: string | null = null;
  for (const step of PUBLISHING_GUIDE.exampleWorkflow) {
    const argv = step.cli.map((argument) =>
      argument === PUBLISHING_GUIDE_ASSET_ID_PLACEHOLDER ? uploadedAssetId ?? assert.fail('the workflow referenced an asset id before uploading one') : argument
    );
    // Written the way the guide describes it: an asset the document refers to
    // by its immutable id, placed by the author.
    if (uploadedAssetId) publishedDocument = `<p>Panel</p><img src="asset:${uploadedAssetId}" alt="Panel">`;

    stdout = '';
    assert.equal(await run(argv, io), 0, `step failed: ${step.purpose}`);
    transcript.push(stdout);

    const uploaded = /Uploaded asset '([a-f0-9]{64})'/.exec(stdout);
    if (uploaded) uploadedAssetId = uploaded[1] ?? null;
  }

  assert.equal(uploadedAssetId, ASSET_ID, 'the upload step never printed an asset id the next step could use');
  assert.match(transcript[0] ?? '', /paired, profile v3, 1280x720 content box/);
  assert.match(transcript[0] ?? '', /has not reported an observation yet/);

  assert.equal(published.length, 1);
  assert.deepEqual(published[0]?.assetIds, [ASSET_ID]);
  assert.equal(published[0]?.profileVersion, PROFILE.version);
  assert.match(String(published[0]?.html), new RegExp(`<img src="asset:${ASSET_ID}"`));

  // The last step is the one that closes the loop: the agent can tell that the
  // revision it just published is the one on screen, and that it fits.
  assert.match(transcript[3] ?? '', /Render status: active, revision 'rev-guided'/);
  assert.match(transcript[3] ?? '', /Rendered: 1280x720 \(scroll 1280x720\), overflow none\./);
});
