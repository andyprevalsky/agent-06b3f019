import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

function isCanonicalPathInsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function resolveOpenDescriptorPath(descriptor: number): string {
  const descriptorPath =
    process.platform === 'linux' ? `/proc/self/fd/${descriptor}` : `/dev/fd/${descriptor}`;
  try {
    const resolved = realpathSync.native(descriptorPath);
    if (resolved !== descriptorPath) return resolved;
  } catch {
    // Darwin's descriptor filesystem may not expose the vnode path to realpath.
  }
  if (process.platform === 'darwin') {
    const output = execFileSync(
      '/usr/sbin/lsof',
      ['-a', '-p', String(process.pid), '-d', String(descriptor), '-Fn'],
      {
        encoding: 'utf8',
        // Descriptor resolution is part of the synchronous local-file read
        // boundary. Never let a wedged Darwin lsof block the backend event
        // loop indefinitely; timeout/overflow errors fail this read closed.
        timeout: 2_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      }
    );
    const pathLine = output.split('\n').find((line) => line.startsWith('n/'));
    if (pathLine) return realpathSync.native(pathLine.slice(1));
  }
  throw new Error('Unable to resolve the opened local output descriptor');
}

export function readRegularFileNoFollow(path: string, root: string, maxBytes: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('Local output candidate is not a regular file');
    const canonicalRoot = realpathSync.native(root);
    const canonicalPath = resolveOpenDescriptorPath(descriptor);
    if (!isCanonicalPathInsideRoot(canonicalRoot, canonicalPath)) {
      throw new Error('Local output candidate escaped its session directory through a symlink');
    }
    const pathStats = statSync(canonicalPath);
    if (pathStats.dev !== stats.dev || pathStats.ino !== stats.ino) {
      throw new Error('Local output candidate changed while it was being opened');
    }
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
