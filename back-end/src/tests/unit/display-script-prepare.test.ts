/**
 * `display` scripts (.js / .mjs): what prepareSingle and classifyDisplayMedia accept.
 *
 *   URL-fetched script  ─► shown ALONE: a relative import could never resolve inside the
 *                          bundle, so it is refused with an actionable message
 *   base64 / path script ─► accepted as before (a path script gets its imports collected
 *                          earlier, by collectDisplayBundleFiles)
 *   markup renamed .js  ─► refused for ANY `<` opener, not only the HTML_START tags
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSingle } from '../../domains/agent-tools/displayService';
import type { ResolvedItem } from '../../domains/agent-tools/displayTypes';
import type { ToolAgent } from '../../domains/agent-tools/repo';
import { DisplayFetchError, classifyDisplayMedia } from '../../providers/agentTools/media';

const agent: ToolAgent = {
  id: 'agent-display-script',
  userId: 'user-display-script',
  parentAgentId: null,
  title: null,
  goal: 'g',
  temporalWorkflowId: null,
  deletedAt: null,
};

const single = (
  source: string,
  extra: { sourceUrl?: string; filename?: string } = {}
): Extract<ResolvedItem, { type: 'single' }> => ({
  index: 0,
  type: 'single',
  bytes: Buffer.from(source),
  filename: extra.filename ?? 'main.js',
  contentType: extra.sourceUrl === undefined ? '' : 'application/javascript',
  ...(extra.sourceUrl === undefined ? {} : { sourceUrl: extra.sourceUrl }),
});

test('a URL script with a relative import is refused, naming the module', () => {
  const entry = single("import { spin } from './helper.js'; spin();", {
    sourceUrl: 'https://example.com/main.js',
  });
  assert.throws(
    () => prepareSingle(agent, entry),
    (err: unknown) =>
      err instanceof DisplayFetchError &&
      /imports relative modules \(helper\.js\)/.test(err.message) &&
      /file path or a bundle/.test(err.message)
  );
});

test('a URL script with only bare and absolute imports is accepted as a script bundle', () => {
  const entry = single(
    "import * as THREE from 'three'; import x from 'https://cdn.jsdelivr.net/npm/x/x.js'; console.log(THREE, x);",
    { sourceUrl: 'https://example.com/main.js' }
  );
  const prepared = prepareSingle(agent, entry);
  assert.equal(prepared.kind, 'bundle');
  assert.equal(prepared.mimeType, 'text/javascript');
});

test('a script without a source URL keeps its previous behavior (imports handled earlier)', () => {
  const prepared = prepareSingle(agent, single("import './helper.js';"));
  assert.equal(prepared.kind, 'bundle');
});

test('markup renamed .js is refused for any opening tag, not only the HTML allowlist', () => {
  for (const markup of [
    '<span>hello</span>',
    '  <my-widget></my-widget>',
    '<!-- note --><b>x</b>',
  ]) {
    assert.equal(
      classifyDisplayMedia(Buffer.from(markup), { filename: 'panel.js' }),
      null,
      `markup ${markup} is not a script`
    );
  }
  assert.equal(
    classifyDisplayMedia(Buffer.from('export const a = 1 < 2;'), { filename: 'ok.js' }),
    'text/javascript',
    'a comparison later in a script is fine'
  );
});
