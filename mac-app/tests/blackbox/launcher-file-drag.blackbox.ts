/**
 * Pure file-drag type detection used by the launcher drop surface.
 *
 * Cement: macOS screenshot/Finder drags must count as file drags even when
 * `types` omits the literal `Files` string during dragover.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  extractDroppedFiles,
  extractDroppedFilesAsync,
  looksLikeFileDrag,
} from '../../ui/features/launcher/fileDrag';

function dt(partial: {
  types?: string[];
  files?: File[];
  items?: Array<{ kind: string; type: string; getAsFile?: () => File | null }>;
  getData?: (type: string) => string;
}): DataTransfer {
  return {
    types: partial.types ?? [],
    files: partial.files ?? ([] as unknown as FileList),
    items: (partial.items ?? []) as unknown as DataTransferItemList,
    getData: partial.getData ?? (() => ''),
  } as DataTransfer;
}

describe('looksLikeFileDrag', () => {
  it('accepts the standard Files type', () => {
    expect(looksLikeFileDrag(dt({ types: ['Files'] }))).toBe(true);
  });

  it('accepts macOS screenshot / Finder uri-list drags without Files', () => {
    expect(looksLikeFileDrag(dt({ types: ['text/uri-list'] }))).toBe(true);
    expect(looksLikeFileDrag(dt({ types: ['public.file-url'] }))).toBe(true);
  });

  it('accepts DataTransferItem kind=file even when types are empty', () => {
    expect(
      looksLikeFileDrag(
        dt({
          types: [],
          items: [{ kind: 'file', type: 'image/png' }],
        })
      )
    ).toBe(true);
  });

  it('rejects non-file drags', () => {
    expect(looksLikeFileDrag(dt({ types: ['text/plain'] }))).toBe(false);
    expect(looksLikeFileDrag(null)).toBe(false);
    expect(looksLikeFileDrag(undefined)).toBe(false);
  });

  it('accepts types that merely contain "file" and populated files[]', () => {
    expect(looksLikeFileDrag(dt({ types: ['application/x-something-file'] }))).toBe(true);
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    expect(
      looksLikeFileDrag(
        dt({
          types: [],
          files: [file],
        })
      )
    ).toBe(true);
  });

  it('falls through empty items/files and nullish types without claiming a drag', () => {
    expect(
      looksLikeFileDrag(
        dt({
          types: [],
          items: [{ kind: 'string', type: 'text/plain' }],
        })
      )
    ).toBe(false);
    expect(
      looksLikeFileDrag({
        types: undefined,
        files: undefined,
        items: undefined,
      } as unknown as DataTransfer)
    ).toBe(false);
  });
});

describe('extractDroppedFiles', () => {
  it('prefers dataTransfer.files when populated', () => {
    const file = new File(['png'], 'Screen Shot.png', { type: 'image/png' });
    expect(extractDroppedFiles(dt({ files: [file] }))).toEqual([file]);
  });

  it('falls back to items.getAsFile when files[] is empty (screenshot drop)', () => {
    // Repro: macOS screenshot thumbnail drop often leaves FileList empty and
    // only exposes the File through DataTransferItem.getAsFile().
    const file = new File(['png'], 'Screen Shot 2026-08-06.png', { type: 'image/png' });
    const extracted = extractDroppedFiles(
      dt({
        types: ['text/uri-list'],
        files: [],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      })
    );
    expect(extracted).toEqual([file]);
  });

  it('returns empty when neither files nor file-items are present', () => {
    expect(extractDroppedFiles(dt({ types: ['text/uri-list'], files: [] }))).toEqual([]);
    expect(extractDroppedFiles(null)).toEqual([]);
  });
});

describe('extractDroppedFilesAsync', () => {
  it('resolves file:// uri-list entries when File objects are unavailable', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob([bytes], { type: 'image/png' }),
      }))
    );

    const files = await extractDroppedFilesAsync(
      dt({
        types: ['text/uri-list'],
        files: [],
        getData: (type) => (type === 'text/uri-list' ? 'file:///tmp/Screen%20Shot.png\n' : ''),
      })
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('Screen Shot.png');
    expect(files[0]?.type).toBe('image/png');
    vi.unstubAllGlobals();
  });

  // `decodeURIComponent` throws URIError on an invalid escape. Letting that
  // propagate rejected the whole drop, losing every other dragged file.
  it('keeps a malformed percent-escape from rejecting the whole drop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }),
      }))
    );

    const files = await extractDroppedFilesAsync(
      dt({
        types: ['text/uri-list'],
        files: [],
        getData: (type) =>
          type === 'text/uri-list' ? 'file:///tmp/%ZZ\nfile:///tmp/Good%20One.png\n' : '',
      })
    );

    // Both survive: the malformed name falls back to its raw segment.
    expect(files.map((file) => file.name)).toEqual(['%ZZ', 'Good One.png']);
    vi.unstubAllGlobals();
  });

  it.each(['file:///tmp/%', 'file:///tmp/%E0%A4%A'])(
    'falls back to the raw segment for truncated escape %s',
    async (uri) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          blob: async () => new Blob([new Uint8Array([1])], { type: 'text/plain' }),
        }))
      );

      const files = await extractDroppedFilesAsync(
        dt({
          types: ['text/uri-list'],
          files: [],
          getData: (type) => (type === 'text/uri-list' ? `${uri}\n` : ''),
        })
      );

      expect(files).toHaveLength(1);
      expect(files[0]?.name).toBe(uri.split('/').pop());
      vi.unstubAllGlobals();
    }
  );
});
