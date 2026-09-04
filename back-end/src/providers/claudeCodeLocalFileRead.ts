import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

export function readRegularFileNoFollow(path: string, maxBytes: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('Local output candidate is not a regular file');
    if (stats.size > maxBytes) {
      throw new Error(`File size exceeds maximum of ${maxBytes / 1024 / 1024}MB`);
    }
    const content = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = readSync(descriptor, content, offset, content.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === content.length ? content : content.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

export function isMissingLocalFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
