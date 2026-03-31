import {
  type FilePointer,
  processUploadedFile,
  getSignedUrl,
  MAX_FILE_SIZE,
} from '../../providers/storage';
import { createLogger } from '../../providers/logger';

const log = createLogger('Upload');

export { MAX_FILE_SIZE };

export class ContentMismatchError extends Error {
  constructor(declaredMime: string) {
    super(
      `Expected ${declaredMime} but received HTML. The file may have been intercepted by a dev server or proxy.`
    );
    this.name = 'ContentMismatchError';
  }
}

/**
 * Validate that file bytes match the declared MIME type.
 * Catches proxy/dev-server issues where HTML error pages are stored as PDFs, etc.
 */
function validateContentType(buffer: Buffer, originalname: string, declaredMime: string): void {
  const head = buffer.subarray(0, 256).toString('utf-8').trimStart().toLowerCase();
  const isHtml = head.startsWith('<!doctype') || head.startsWith('<html');
  if (isHtml && !declaredMime.includes('html')) {
    log.error(
      `Content mismatch: file "${originalname}" (${declaredMime}) contains HTML. Likely a proxy/dev-server error.`
    );
    throw new ContentMismatchError(declaredMime);
  }
}

/**
 * Process and store an uploaded file for a user.
 */
export async function uploadFile(
  userId: string,
  buffer: Buffer,
  originalname: string,
  mimetype: string
): Promise<FilePointer> {
  validateContentType(buffer, originalname, mimetype);

  const filePointer = await processUploadedFile(userId, buffer, originalname, mimetype);

  log.info(
    `Uploaded file for user ${userId}: ${filePointer.original_filename} (${filePointer.size_bytes} bytes)`
  );

  return filePointer;
}

/**
 * Generate a signed URL for a file, verifying ownership.
 */
export async function getFileSignedUrl(
  userId: string,
  storagePath: string
): Promise<{ signed_url: string; expires_in: number }> {
  if (!storagePath.startsWith(`${userId}/`)) {
    throw new AccessDeniedError();
  }

  const signedUrl = await getSignedUrl(storagePath, 3600);

  return {
    signed_url: signedUrl,
    expires_in: 3600,
  };
}

export class AccessDeniedError extends Error {
  constructor() {
    super('Access denied to this file');
    this.name = 'AccessDeniedError';
  }
}
