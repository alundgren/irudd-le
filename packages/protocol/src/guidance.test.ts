import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASSET_CONTENT_TYPES,
  CHANNEL_ID_PATTERN,
  PROTOCOL_VERSION,
  PUBLISHING_GUIDE,
  PUBLISHING_GUIDE_ASSET_ID_PLACEHOLDER,
  PUBLISHING_GUIDE_CLI_BIN,
  PUBLISHING_GUIDE_EXAMPLE_SECTION_ID,
  PUBLISHING_GUIDE_VERSION,
  REVISION_DESCRIPTION_MAX_LENGTH,
  REVISION_TITLE_MAX_LENGTH,
  renderPublishingGuideText,
} from './index';

test('the publishing guide is versioned separately from the contract it describes', () => {
  assert.equal(PUBLISHING_GUIDE.guideVersion, PUBLISHING_GUIDE_VERSION);
  assert.equal(PUBLISHING_GUIDE.protocolVersion, PROTOCOL_VERSION);
});

test('the publishing guide covers every subject a fresh agent has to know', () => {
  const covered = PUBLISHING_GUIDE.sections.map((section) => section.id);
  for (const required of ['credentials', 'channels', 'target-profile', 'static-content', 'assets', 'render-status', 'fallback', 'example']) {
    assert.ok(covered.includes(required), `missing guide section '${required}'`);
  }
});

/** The text rendering wraps prose, so compare against a whitespace-insensitive form. */
function flattened(): string {
  return renderPublishingGuideText().replace(/\s+/g, ' ');
}

test('the plain-text rendering carries every section, step, and exclusion', () => {
  const text = flattened();

  for (const section of PUBLISHING_GUIDE.sections) {
    assert.ok(text.includes(section.title.toUpperCase()), `rendered text is missing section '${section.title}'`);
    for (const paragraph of section.body) assert.ok(text.includes(paragraph), `rendered text is missing a paragraph of '${section.id}'`);
  }
  for (const step of PUBLISHING_GUIDE.exampleWorkflow) {
    assert.ok(text.includes(step.purpose), `rendered text is missing step '${step.purpose}'`);
    assert.ok(text.includes(step.cli.join(' ')), `rendered text is missing the CLI form of '${step.purpose}'`);
    assert.ok(text.includes(step.browser), `rendered text is missing the browser form of '${step.purpose}'`);
  }
  for (const excluded of PUBLISHING_GUIDE.excludes) {
    assert.ok(text.includes(excluded), 'rendered text is missing a declared exclusion');
  }
});

test('the guide quotes contract limits from the contract itself', () => {
  const text = flattened();

  for (const contentType of ASSET_CONTENT_TYPES) assert.ok(text.includes(contentType), `guide never names ${contentType}`);
  assert.ok(text.includes(CHANNEL_ID_PATTERN.source), 'guide never states the channel id rule');
  assert.ok(text.includes(String(REVISION_TITLE_MAX_LENGTH)), 'guide never states the title limit');
  assert.ok(text.includes(String(REVISION_DESCRIPTION_MAX_LENGTH)), 'guide never states the description limit');
});

test('the example workflow threads the uploaded asset id into the publication', () => {
  const [, upload, publish] = PUBLISHING_GUIDE.exampleWorkflow;

  assert.equal(upload?.cli[0], 'upload-asset');
  assert.equal(publish?.cli[0], 'publish');
  assert.ok(publish?.cli.includes(PUBLISHING_GUIDE_ASSET_ID_PLACEHOLDER), 'the publish step never consumes the uploaded asset id');
  assert.ok(!PUBLISHING_GUIDE.exampleWorkflow.some((step) => step.cli.includes('--secret')), 'the example must not put a credential on the command line');
});

test('the guide stays out of permanently excluded territory', () => {
  const text = flattened().toLowerCase();
  for (const excluded of ['last epoch', 'build planner', 'loot filter']) {
    assert.ok(!text.includes(excluded), `guide must not give game-specific guidance about '${excluded}'`);
  }
});

test('the example section introduces the numbered steps that follow it', () => {
  const last = PUBLISHING_GUIDE.sections.at(-1);

  assert.equal(last?.id, PUBLISHING_GUIDE_EXAMPLE_SECTION_ID, 'the steps are rendered after every section, so the section introducing them must come last');
});

test('prose wraps for a narrow terminal, but commands stay on one copyable line', () => {
  const lines = renderPublishingGuideText().split('\n');

  for (const line of lines.filter((candidate) => !candidate.includes(PUBLISHING_GUIDE_CLI_BIN))) {
    assert.ok(line.length <= 80, `rendered prose line is too long to read: ${line}`);
  }
  assert.ok(lines.some((line) => line.includes(`${PUBLISHING_GUIDE_CLI_BIN} status --mailbox-url`)), 'no runnable command survived rendering');
});

test('every rendered command is runnable as written, without shell quoting', () => {
  // Both renderers print `step.cli.join(' ')` while the guided-workflow fixture
  // executes the argv array. An argument containing whitespace or a quote would
  // make the printed command silently disagree with the executed one.
  for (const step of PUBLISHING_GUIDE.exampleWorkflow) {
    for (const argument of step.cli) {
      assert.doesNotMatch(argument, /[\s'"\\]/, `'${argument}' cannot be printed as a runnable command without quoting`);
    }
  }
});
