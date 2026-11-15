import path from 'node:path';

/** Plain control object written when a root bundle's finalization starts. */
export const TRACE_ARCHIVE_FINALIZING_MARKER_PATH = 'manifest.finalization-fence.json';

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96) || 'unbound';
}

export function safeArchivePath(input: string): string {
  return input
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .map(safeSegment)
    .join('/');
}

export function localArchiveRoot(): string {
  return process.env.TRACE_ARCHIVE_LOCAL_DIR || path.resolve(process.cwd(), '..', '.context');
}

export function objectKey(rootAgentId: string, objectPath: string): string {
  return `trace-archive/${safeSegment(rootAgentId)}/${safeArchivePath(objectPath)}`;
}

export function objectPrefix(rootAgentId: string): string {
  return `trace-archive/${safeSegment(rootAgentId)}/`;
}

export function localObjectPath(rootAgentId: string, objectPath: string): string {
  return path.join(localArchiveRoot(), objectKey(rootAgentId, objectPath));
}
