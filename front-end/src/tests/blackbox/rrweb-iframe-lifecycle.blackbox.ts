/** Real installed replay recorder must retire removed iframe document trees. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { transformReplayLifecycle } from '../../../scripts/patch-replay-lifecycle.mjs';

const requireSdk = createRequire(import.meta.url);
const sourcePath = requireSdk
  .resolve('@amplitude/rrweb-record')
  .replace('rrweb-record.cjs', 'rrweb-record.js');
function loadRecorder(format: 'esm' | 'cjs') {
  const source =
    readFileSync(
      format === 'esm' ? sourcePath : sourcePath.replace('rrweb-record.js', 'rrweb-record.cjs'),
      'utf8',
    ) +
    (format === 'esm'
      ? '\nexport const inspectBuffers = () => mutationBuffers;\n'
      : '\nexports.inspectBuffers = () => mutationBuffers;\n');
  const compiled =
    format === 'cjs'
      ? source
      : ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText;
  const module = {
    exports: {} as {
      record: ((options: object) => () => void) & {
        takeFullSnapshot: () => void;
        mirror: {
          getId: (node: Node) => number;
          getNode: (id: number) => Node | null;
          removeNodeFromMap: (node: Node) => void;
          getIds: () => number[];
        };
      };
      inspectBuffers: () => { doc: Document }[];
    },
  };
  new Function('require', 'exports', 'module', compiled)(requireSdk, module.exports, module);
  return module.exports;
}
afterEach(() => {
  document.querySelectorAll('iframe').forEach((frame) => frame.remove());
});

it('validates the complete installed replay repair and rejects partial or unknown shapes', () => {
  const source = readFileSync(sourcePath, 'utf8');
  expect(transformReplayLifecycle(source)).toBe(source);
  expect(() =>
    transformReplayLifecycle(source + '\n/* rose-replay-document-lifecycle */'),
  ).toThrow();
  expect(() =>
    transformReplayLifecycle(
      source.replace(
        '      mirror.reset();\n      processedNodeManager.destroy();',
        '      processedNodeManager.destroy();',
      ),
    ),
  ).toThrow();
  expect(() => transformReplayLifecycle('new upstream layout')).toThrow();
});

for (const format of ['esm', 'cjs'] as const)
  describe('Replay iframe lifecycle ' + format, () => {
    const recorder = () => loadRecorder(format);
    it('does not capture a pending iframe load after its recorder stops', () => {
      const sdk = recorder();
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      const doc = frame.contentDocument!;
      doc.body.innerHTML = '<p>Frame bytes arrive after recorder stop</p>';
      // Hold only browser readiness; the installed SDK performs all capture.
      Object.defineProperty(doc, 'readyState', { configurable: true, get: () => 'loading' });
      const addListener = vi.spyOn(doc, 'addEventListener');
      const emit = vi.fn();
      const stop = sdk.record({ emit, recordCanvas: false });
      window.dispatchEvent(new Event('load'));
      try {
        expect(sdk.inspectBuffers().some((buffer) => buffer.doc === doc)).toBe(false);
        stop();
        expect(sdk.inspectBuffers()).toHaveLength(0);
        expect(sdk.record.mirror.getIds()).toHaveLength(0);
        const listenersAtStop = addListener.mock.calls.length;
        const eventsAtStop = emit.mock.calls.length;
        frame.dispatchEvent(new Event('load'));
        expect.soft(sdk.inspectBuffers()).toHaveLength(0);
        expect.soft(sdk.record.mirror.getIds()).toHaveLength(0);
        expect.soft(addListener.mock.calls.length).toBe(listenersAtStop);
        expect.soft(emit.mock.calls.length).toBe(eventsAtStop);
        const reopened = sdk.record({ emit: () => {}, recordCanvas: false });
        window.dispatchEvent(new Event('load'));
        try {
          frame.dispatchEvent(new Event('load'));
          expect(sdk.inspectBuffers().filter((buffer) => buffer.doc === doc)).toHaveLength(1);
          expect(sdk.record.mirror.getId(doc.querySelector('p')!)).toBeGreaterThan(0);
        } finally {
          reopened();
        }
      } finally {
        stop?.();
        addListener.mockRestore();
        frame.remove();
      }
    });

    it('removes a closed iframe canvas from the real recorder mirror', async () => {
      const sdk = recorder();
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      const canvas = frame.contentDocument!.createElement('canvas');
      frame.contentDocument!.body.appendChild(canvas);
      const stop = sdk.record({ emit: () => {}, recordCanvas: false });
      window.dispatchEvent(new Event('load'));
      await waitFor(() => expect(sdk.inspectBuffers().length).toBeGreaterThan(0));
      frame.dispatchEvent(new Event('load'));
      try {
        await waitFor(() => expect(sdk.record.mirror.getId(canvas)).toBeGreaterThan(0));
        const id = sdk.record.mirror.getId(canvas);
        sdk.record.mirror.removeNodeFromMap(frame);
        await waitFor(() => expect(sdk.record.mirror.getNode(id)).toBeNull());
      } finally {
        frame.remove();
        stop?.();
      }
    });

    it('keeps a live sibling observed after another iframe exits, then clears all documents on stop', async () => {
      const sdk = recorder();
      const frames = [document.createElement('iframe'), document.createElement('iframe')];
      for (const frame of frames) document.body.appendChild(frame);
      const docs = frames.map((frame) => frame.contentDocument!);
      docs.forEach((doc) => {
        doc.body.innerHTML = '<p>Live sibling</p>';
      });
      const events: {
        data?: { attributes?: { id: number; attributes: Record<string, string> }[] };
      }[] = [];
      const stop = sdk.record({
        emit: (event: (typeof events)[number]) => events.push(event),
        recordCanvas: false,
      });
      window.dispatchEvent(new Event('load'));
      frames.forEach((frame) => frame.dispatchEvent(new Event('load')));
      try {
        await waitFor(() =>
          expect(
            docs.every((doc) => sdk.inspectBuffers().some((buffer) => buffer.doc === doc)),
          ).toBe(true),
        );
        frames[0].remove();
        await waitFor(() =>
          expect(sdk.inspectBuffers().some((buffer) => buffer.doc === docs[0])).toBe(false),
        );
        expect(sdk.inspectBuffers().some((buffer) => buffer.doc === docs[1])).toBe(true);
        const paragraph = docs[1].querySelector('p')!;
        const id = sdk.record.mirror.getId(paragraph);
        paragraph.setAttribute('data-owner-check', 'still-recorded');
        await waitFor(() =>
          expect(
            events.some((event) =>
              event.data?.attributes?.some(
                (change) =>
                  change.id === id && change.attributes['data-owner-check'] === 'still-recorded',
              ),
            ),
          ).toBe(true),
        );
        stop();
        expect(sdk.inspectBuffers()).toHaveLength(0);
        expect(sdk.record.mirror.getIds()).toHaveLength(0);
      } finally {
        stop?.();
        frames.forEach((frame) => frame.remove());
      }
    });

    it('retires the detached iframe document mutation buffer', async () => {
      const sdk = recorder();
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      const doc = frame.contentDocument!;
      doc.body.innerHTML = '<p>Recorded frame content remains replayable.</p>';
      const stop = sdk.record({ emit: () => {}, recordCanvas: false });
      window.dispatchEvent(new Event('load'));
      await waitFor(() => expect(sdk.inspectBuffers().length).toBeGreaterThan(0));
      frame.dispatchEvent(new Event('load'));
      try {
        await waitFor(() =>
          expect(sdk.inspectBuffers().some((buffer) => buffer.doc === doc)).toBe(true),
        );
        frame.remove();
        await waitFor(() =>
          expect(sdk.inspectBuffers().some((buffer) => buffer.doc === doc)).toBe(false),
        );
      } finally {
        frame.remove();
        stop?.();
      }
    });

    it('records replacement and re-added iframe documents without retaining retired owners', async () => {
      const sdk = recorder();
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      frame.contentDocument!.body.innerHTML = '<p>Original document</p>';
      const stop = sdk.record({ emit: () => {}, recordCanvas: false });
      window.dispatchEvent(new Event('load'));
      const original = frame.contentDocument!;
      frame.dispatchEvent(new Event('load'));
      try {
        await waitFor(() =>
          expect(sdk.inspectBuffers().some((buffer) => buffer.doc === original)).toBe(true),
        );
        frame.src = 'about:blank';
        await waitFor(() => expect(frame.contentDocument?.readyState).toBe('complete'));
        const replacement = frame.contentDocument!;
        expect(replacement).not.toBe(original);
        replacement.body.innerHTML = '<p>Replacement document</p>';
        sdk.record.takeFullSnapshot();
        frame.dispatchEvent(new Event('load'));
        await waitFor(() =>
          expect(sdk.inspectBuffers().some((buffer) => buffer.doc === replacement)).toBe(true),
        );
        expect(sdk.inspectBuffers().some((buffer) => buffer.doc === original)).toBe(false);
        frame.remove();
        await waitFor(() =>
          expect(sdk.inspectBuffers().some((buffer) => buffer.doc === replacement)).toBe(false),
        );
        document.body.appendChild(frame);
        await waitFor(() => expect(frame.contentDocument?.readyState).toBe('complete'));
        const readded = frame.contentDocument!;
        readded.body.innerHTML = '<p>Re-added document remains visible</p>';
        sdk.record.takeFullSnapshot();
        frame.dispatchEvent(new Event('load'));
        await waitFor(() =>
          expect(sdk.inspectBuffers().some((buffer) => buffer.doc === readded)).toBe(true),
        );
        expect(sdk.record.mirror.getId(readded.querySelector('p')!)).toBeGreaterThan(0);
        stop();
        expect(sdk.inspectBuffers()).toHaveLength(0);
        expect(sdk.record.mirror.getIds()).toHaveLength(0);
      } finally {
        stop?.();
        frame.remove();
      }
    });
  });
