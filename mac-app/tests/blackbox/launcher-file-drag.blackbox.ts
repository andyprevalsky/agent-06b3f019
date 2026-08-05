/**
 * Pure file-drag type detection used by the launcher drop surface.
 *
 * Cement: macOS screenshot/Finder drags must count as file drags even when
 * `types` omits the literal `Files` string during dragover.
 */

import { describe, it, expect } from 'vitest';
import { looksLikeFileDrag } from '../../ui/features/launcher/fileDrag';

function dt(partial: {
  types?: string[];
  files?: File[];
  items?: Array<{ kind: string; type: string }>;
}): DataTransfer {
  return {
    types: partial.types ?? [],
    files: partial.files ?? ([] as unknown as FileList),
    items: (partial.items ?? []) as unknown as DataTransferItemList,
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
