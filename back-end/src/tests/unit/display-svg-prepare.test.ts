/**
 * `display` SVG (owner decision 2026-11-08): an SVG is an image, never a page.
 *
 *   .svg / image/svg+xml / undeclared <svg> root ─► image/svg+xml, kind image,
 *       stored at <owner>/display/<sha>.svg with no usercontent page URL
 *   markup that is not an <svg> root, declared .svg ─► refused
 *   a declared .html page ─► still text/html (unchanged); png/pdf unchanged
 *   signed SVG URLs force a download (never opened as a page)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSingle } from '../../domains/agent-tools/displayService';
import type { ResolvedItem } from '../../domains/agent-tools/displayTypes';
import type { ToolAgent } from '../../domains/agent-tools/repo';
import { classifyDisplayMedia } from '../../providers/agentTools/media';
import { signedUrlOptions } from '../../providers/storage';

const agent: ToolAgent = {
  id: 'agent-display-svg',
  userId: 'user-display-svg',
  parentAgentId: null,
  title: null,
  goal: 'g',
  temporalWorkflowId: null,
  deletedAt: null,
};

const CHART =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!-- revenue -->\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>';
const SCRIPTED =
  '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'/beacon\')"><script>fetch(\'/beacon\')</script></svg>';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const single = (
  bytes: string | Buffer,
  filename: string,
  contentType = ''
): Extract<ResolvedItem, { type: 'single' }> => ({
  index: 0,
  type: 'single',
  bytes: typeof bytes === 'string' ? Buffer.from(bytes) : bytes,
  filename,
  contentType,
});

test('an SVG is classified as image/svg+xml whether named, typed or undeclared', () => {
  assert.equal(
    classifyDisplayMedia(Buffer.from(CHART), { filename: 'chart.svg' }),
    'image/svg+xml'
  );
  assert.equal(
    classifyDisplayMedia(Buffer.from(CHART), { contentType: 'image/svg+xml; charset=utf-8' }),
    'image/svg+xml'
  );
  assert.equal(classifyDisplayMedia(Buffer.from(CHART), { filename: 'chart' }), 'image/svg+xml');
  const doctype =
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"/>';
  assert.equal(classifyDisplayMedia(Buffer.from(doctype), { filename: 'd.svg' }), 'image/svg+xml');
});

test('a standalone SVG is an image, not an HTML page; a declared page and other types are unchanged', () => {
  assert.equal(
    classifyDisplayMedia(Buffer.from('<html><body>x</body></html>'), { filename: 'x.svg' }),
    null
  );
  assert.equal(
    classifyDisplayMedia(Buffer.from('<!doctype html><html><body>x</body></html>'), {
      filename: 'p.html',
    }),
    'text/html'
  );
  assert.equal(classifyDisplayMedia(Buffer.from('<svg/>'), { filename: 'page.html' }), 'text/html');
  assert.equal(
    classifyDisplayMedia(Buffer.from('<html><script>1</script>'), { filename: 'x.png' }),
    null
  );
  assert.equal(classifyDisplayMedia(PNG, { filename: 'logo.svg' }), 'image/png');
  assert.equal(
    classifyDisplayMedia(Buffer.from('%PDF-1.4\n'), { filename: 'a.pdf' }),
    'application/pdf'
  );
});

test('a displayed SVG, scripted or not, is stored as an image at a .svg path, never as a page', () => {
  for (const source of [CHART, SCRIPTED]) {
    const prepared = prepareSingle(agent, single(source, 'chart.svg'));
    assert.equal(prepared.mimeType, 'image/svg+xml');
    assert.equal(prepared.kind, 'image');
    const pointer = prepared.filePointer as Record<string, unknown>;
    assert.equal(pointer.mime_type, 'image/svg+xml');
    assert.match(String(pointer.storage_path), /^user-display-svg\/display\/[0-9a-f]{64}\.svg$/);
    assert.equal(pointer.original_filename, 'chart.svg');
    assert.equal(pointer.usercontent_url, undefined);
  }
});

test('signed SVG URLs force a download; other files keep inline signing', () => {
  assert.deepEqual(signedUrlOptions('u/display/abc.svg'), { download: true });
  assert.deepEqual(signedUrlOptions('u/display/ABC.SVG'), { download: true });
  assert.equal(signedUrlOptions('u/display/abc.png'), undefined);
  assert.equal(signedUrlOptions('u/display/abc.html'), undefined);
});
