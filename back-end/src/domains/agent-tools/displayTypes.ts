import type { DisplayFilePointer, DisplayKind } from './types';

export type ResolvedItem =
  | {
      index: number;
      type: 'single';
      bytes: Buffer;
      filename: string;
      contentType: string;
      /** URL-fetched pages keep resolving relative links against their origin. */
      sourceUrl?: string;
    }
  | { index: number; type: 'bundle'; entry: string; files: Map<string, Buffer> };

export interface PreparedItem {
  index: number;
  sha256: string;
  mimeType: string;
  kind: DisplayKind;
  sizeBytes: number;
  filePointer: DisplayFilePointer;
  store: () => Promise<void>;
}
