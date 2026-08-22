import {
  ASSET_CONTENT_TYPES,
  CHANNEL_ID_PATTERN,
  PROTOCOL_VERSION,
  REVISION_DESCRIPTION_MAX_LENGTH,
  REVISION_TITLE_MAX_LENGTH,
  type ProtocolVersion,
} from './contract.js';

/**
 * Bumped whenever the guidance text changes. It is deliberately independent
 * of PROTOCOL_VERSION: the wire contract can stay still while the advice for
 * using it improves, and a clarified sentence must not look like a breaking
 * protocol change.
 */
export const PUBLISHING_GUIDE_VERSION = 2;

export interface PublishingGuideSection {
  id: string;
  title: string;
  /** One element per paragraph. Each renderer decides how to break lines. */
  body: readonly string[];
}

/**
 * One step of the example workflow, in both supported forms. The CLI form is
 * literal argv rather than a prose command line so a test can execute exactly
 * what the guide publishes.
 */
export interface PublishingGuideStep {
  purpose: string;
  cli: readonly string[];
  browser: string;
}

export interface PublishingGuide {
  /** The contract version this guidance describes. */
  protocolVersion: ProtocolVersion;
  guideVersion: number;
  title: string;
  summary: readonly string[];
  /** The example workflow is rendered after the sections, so it comes last. */
  sections: readonly PublishingGuideSection[];
  exampleWorkflow: readonly PublishingGuideStep[];
  /** Subjects this guidance deliberately never covers. */
  excludes: readonly string[];
}

/** The example workflow's third step consumes the asset id its second step prints. */
export const PUBLISHING_GUIDE_ASSET_ID_PLACEHOLDER = 'ASSET_ID_FROM_STEP_2';

/** The binary name the guide quotes for every CLI step. */
export const PUBLISHING_GUIDE_CLI_BIN = 'irudd-le-mailbox';

/** The section whose body introduces the numbered example workflow. */
export const PUBLISHING_GUIDE_EXAMPLE_SECTION_ID = 'example';

const GUIDE_MAILBOX_URL = 'https://mailbox.example/';
const GUIDE_CHANNEL = 'main';

/**
 * The single canonical publishing guidance for this system. The CLI's help
 * output and the browser UI's on-page copy are both rendered from this value,
 * so neither can drift from the other or from the contract constants it quotes.
 */
export const PUBLISHING_GUIDE: PublishingGuide = {
  protocolVersion: PROTOCOL_VERSION,
  guideVersion: PUBLISHING_GUIDE_VERSION,
  title: 'Publishing to an irudd-le channel',
  summary: [
    "The mailbox is the authority for channels, revisions, and assets. You publish a static HTML document to a named channel; one enrolled overlay target displays that channel's latest valid revision, and reports back what it actually rendered.",
    `There are two supported publishing paths, the CLI and the browser UI. Both speak the same protocol (v${PROTOCOL_VERSION}) and need the same publisher credential.`,
  ],
  sections: [
    {
      id: 'credentials',
      title: 'Credentials',
      body: [
        'A publisher credential is bound to exactly one channel and is shown only once, when it is created. Both publishing paths need one; neither can mint one.',
        'Prefer the MAILBOX_SECRET environment variable over the --secret flag, so the secret never lands in shell history or a process listing. The CLI never echoes a credential back to stdout or stderr.',
      ],
    },
    {
      id: 'channels',
      title: 'Channels: paired and unbound',
      body: [
        `A channel is a stable, named destination that stays meaningful while its target is offline. Its id is a lowercase slug matching ${CHANNEL_ID_PATTERN.source}.`,
        'A paired channel has exactly one enrolled overlay target, so it reports a target profile and, once the target has observed a revision, a render status.',
        'An unbound channel has no target yet. You can still publish to it: both paths record the revision with profile version 1, and the target may pick it up when it pairs, if its profile version still matches. Until then there is no target-accurate preview and no render status, so nothing can confirm the document fits. Treat an unbound publication as provisional and inspect the channel again after pairing.',
      ],
    },
    {
      id: 'target-profile',
      title: 'Inspect the target profile before writing HTML',
      body: [
        'The target profile is the layout budget, and it is locked per publication. Read it first rather than guessing at a size.',
        'contentBox width and height are the hard CSS-pixel budget: content that exceeds it overflows. Electron BrowserWindow bounds use device-independent pixels, and the renderer reports the same content box in CSS pixels. devicePixelRatio maps that box to physical pixels. screenshot width is round(contentBox.width × devicePixelRatio), and screenshot height uses the same calculation. Use CSS dimensions that fit contentBox; multiply by devicePixelRatio only when you need the physical-pixel capacity. minimumTextSize is the smallest legible size at couch distance, where the reader cannot lean in. preferredIconSize gives the min/max icon edge the target wants. background.opaque says whether you can rely on a solid backdrop or must stay readable over the game. features lists optional capabilities; assume nothing that is not listed.',
        'The profile carries a version. A publication is validated against one profile version, so inspect again after the target reports a changed profile.',
      ],
    },
    {
      id: 'static-content',
      title: 'What a published document may contain',
      body: [
        'A revision is static HTML, CSS, and inline SVG. The content shell renders it in an opaque sandbox that denies the network entirely.',
        'Script, navigation, forms, iframes, and remote fonts never run. Do not ship a document whose layout depends on them; it will not degrade, it will simply be missing that behaviour.',
        'Images may use only a data: URL or an asset: reference (see below). An ordinary http(s) image URL is rejected while the revision is staged, and srcset is rejected outright. A rejected revision never becomes visible: the previously published revision keeps rendering, so a bad publication is safe but invisible.',
        `A title is at most ${REVISION_TITLE_MAX_LENGTH} characters, and an optional description, set with --description, is at most ${REVISION_DESCRIPTION_MAX_LENGTH}.`,
      ],
    },
    {
      id: 'assets',
      title: 'Publishing images',
      body: [
        `The mailbox accepts exactly two image formats: ${ASSET_CONTENT_TYPES.join(' and ')}.`,
        'Uploading returns an immutable id which is the SHA-256 of the bytes, so the same image always has the same id and uploading it twice is harmless. The upload also grants that channel access to the asset; an id from another channel is not usable until it has been uploaded there too.',
        'A document refers to an uploaded image as <img src="asset:ID">, and the revision must also declare that id in its asset list. The overlay fetches and verifies each declared asset in its authenticated process and substitutes a data URL only inside the sandbox. Declare each id exactly once; the document may then reference it as many times as it likes.',
        'CLI: upload the file, then pass each id with a repeatable --asset-id flag and place the <img> yourself, anywhere in the document. The CLI derives the content type from the file extension, so the file must be named .png or .webp — a correct PNG named .jpg or .jpeg is refused before it is ever uploaded. Pass --html-file - to read a generated document from stdin instead of writing a temporary file.',
        'Browser UI: choose one image; it is uploaded, previewed, and appended to the end of the document for you. You do not write the <img> tag, and one publication carries at most one image. This is the main asymmetry between the two paths: if you need several images, or an image placed inline, use the CLI.',
      ],
    },
    {
      id: 'render-status',
      title: 'Reading render status and correcting a rejection',
      body: [
        'Publishing is not the end of the loop. The target observes each candidate revision and reports an activation of active or rejected, the rendered and scroll dimensions, horizontal and vertical overflow flags, when it observed them, and whether it is currently online.',
        'No render status at all means the paired target has not reported yet — it may be offline. That is not a failure. Inspect again rather than republishing blindly.',
        'active means your revision is the visible one. rejected carries a failure reason, and the previous revision stays on screen.',
        'Read the overflow flags even on an active revision. Activation and overflow are independent: a revision can be active and still overflow its content box, which is the silent-truncation case an author most needs to catch.',
        'The usual correction is size. Overflow means the document exceeded the profile contentBox: reduce content, shrink images toward preferredIconSize, or use a denser layout — but never below minimumTextSize, which exists because the reader is at couch distance. Then publish again and read the status again; each publication produces a fresh observation.',
      ],
    },
    {
      id: 'fallback',
      title: 'Universal fallback: the browser UI',
      body: [
        'The CLI needs shell access to a machine with Node installed. When you do not have that, the browser UI is the universal fallback: any machine with a browser, no install, same mailbox, same contract, same publisher credential.',
        'What you give up: one image per publication, appended rather than placed; and a preview that is an approximation, not the overlay renderer. The preview is scaled to fit the page and its sanitiser strips more than the overlay does, so treat it as a layout check, not as proof of what will render.',
        'The browser UI does not report render status. After publishing from it, confirm activation with the CLI status command shown in the workflow below, or against the mailbox directly.',
        'Use the CLI when you have shell access, need several images, or need inline image placement. Use the browser UI otherwise.',
      ],
    },
    {
      id: PUBLISHING_GUIDE_EXAMPLE_SECTION_ID,
      title: 'A compact, verifiable example workflow',
      body: [
        `Publishing one image-backed document to the channel "${GUIDE_CHANNEL}". Export the publisher credential once (export MAILBOX_SECRET=...) so no step repeats it.`,
        `Step 3 substitutes ${PUBLISHING_GUIDE_ASSET_ID_PLACEHOLDER} with the asset id step 2 printed.`,
      ],
    },
  ],
  exampleWorkflow: [
    {
      purpose: 'Inspect the channel, its target profile, and its last render status',
      cli: ['status', '--mailbox-url', GUIDE_MAILBOX_URL, '--channel', GUIDE_CHANNEL],
      browser: 'Enter the mailbox URL, channel, and publisher credential, then press "Load target profile".',
    },
    {
      purpose: 'Upload the image and note the asset id it prints',
      cli: ['upload-asset', '--mailbox-url', GUIDE_MAILBOX_URL, '--channel', GUIDE_CHANNEL, '--file', './panel.png'],
      browser: 'Choose the file under "Upload PNG or WebP image" and wait for it to appear in the preview.',
    },
    {
      purpose: 'Publish a document that fits the content box and references the asset',
      cli: ['publish', '--mailbox-url', GUIDE_MAILBOX_URL, '--channel', GUIDE_CHANNEL, '--title', 'Panel', '--html-file', './panel.html', '--asset-id', PUBLISHING_GUIDE_ASSET_ID_PLACEHOLDER],
      browser: 'Paste the HTML or choose an HTML file, fill in the title, then press "Publish".',
    },
    {
      purpose: 'Confirm the target activated the new revision rather than rejecting it',
      cli: ['status', '--mailbox-url', GUIDE_MAILBOX_URL, '--channel', GUIDE_CHANNEL],
      browser: 'The browser UI reports no render status; run this step’s CLI command to confirm activation.',
    },
  ],
  excludes: [
    'Acquiring, fetching, or scraping the source data you publish. That is permanently outside this system.',
    'Game-specific content schemas. A revision is plain static HTML and the mailbox never interprets it.',
    'Image formats and transformations beyond uploading the two supported formats unchanged.',
  ],
};

const GUIDE_INDENT = '  ';
const GUIDE_WIDTH = 80;

/** Greedy wrap; the guide's paragraphs are prose, so word boundaries are enough. */
function wrap(paragraph: string, indent: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of paragraph.split(' ')) {
    if (line.length === 0) line = word;
    else if (`${indent}${line} ${word}`.length <= GUIDE_WIDTH) line = `${line} ${word}`;
    else {
      lines.push(`${indent}${line}`);
      line = word;
    }
  }
  if (line.length > 0) lines.push(`${indent}${line}`);
  return lines;
}

/**
 * Renders the canonical guide as the plain text the CLI prints. The browser UI
 * renders the same PUBLISHING_GUIDE value as markup instead of calling this,
 * so both copies stay derived from one source in the form each medium needs.
 */
export function renderPublishingGuideText(): string {
  const guide = PUBLISHING_GUIDE;
  const lines: string[] = [
    `${guide.title} (guide v${guide.guideVersion}, protocol v${guide.protocolVersion})`,
    '',
    ...guide.summary.flatMap((paragraph) => wrap(paragraph, '')),
  ];
  for (const section of guide.sections) {
    lines.push('', section.title.toUpperCase(), ...section.body.flatMap((paragraph) => wrap(paragraph, GUIDE_INDENT)));
  }
  // The numbered steps follow the sections, so the section that introduces
  // them is required to be the last one; PUBLISHING_GUIDE_EXAMPLE_SECTION_ID
  // names it and the protocol tests pin the ordering.
  guide.exampleWorkflow.forEach((step, index) => {
    lines.push(
      '',
      `${GUIDE_INDENT}${index + 1}. ${step.purpose}`,
      `${GUIDE_INDENT}${GUIDE_INDENT}CLI:     ${PUBLISHING_GUIDE_CLI_BIN} ${step.cli.join(' ')}`,
      ...wrap(`Browser: ${step.browser}`, `${GUIDE_INDENT}${GUIDE_INDENT}`)
    );
  });
  lines.push('', 'NOT COVERED HERE', ...guide.excludes.flatMap((line) => wrap(line, GUIDE_INDENT)), '');
  return lines.join('\n');
}
