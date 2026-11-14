const SAFE_ABSOLUTE_FILE_ROOTS = ['/tmp/downloads/', '/tmp/rose-uploads/', '/home/oai/share/'];

export class InvalidSessionFilePathError extends Error {
  constructor() {
    super('Invalid session file path');
    this.name = 'InvalidSessionFilePathError';
  }
}

export function validateSessionFilePath(filePath: string, provider?: string): void {
  const canonical = filePath.replace(/\\/g, '/');
  if (
    canonical.includes('\0') ||
    canonical.split('/').includes('..') ||
    (canonical.startsWith('/') &&
      !SAFE_ABSOLUTE_FILE_ROOTS.some((root) => canonical.startsWith(root)) &&
      !(provider === 'steel' && canonical.startsWith('/files/')))
  ) {
    throw new InvalidSessionFilePathError();
  }
}
