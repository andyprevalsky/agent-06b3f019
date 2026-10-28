/**
 * Browser-session file and input operations (upload, list, download,
 * screenshot, key presses) on a live provider session.
 */
import { createLogger } from '../../providers/logger';
import {
  uploadSessionFile,
  listFiles as listProviderFiles,
  readSessionFile,
  captureScreenshot,
  pressSessionKeys,
} from '../../providers/browser';
import * as repo from './repo';
import { validateBrowserKeySymbols } from './service.browser-input';
import { validateSessionFilePath } from './service.file-path';
import { SessionNotFoundError } from './service.local-storage';

const log = createLogger('BrowserSession');

async function requireSessionOwner(sessionId: string, userId?: string): Promise<void> {
  if (userId === undefined) return;
  const session = await repo.findSessionBySessionId(sessionId);
  if (session === null || session.context.userId !== userId) throw new SessionNotFoundError();
}

/* c8 ignore start -- uploadFile, listFiles require Steel SDK */
// ---------------------------------------------------------------------------
// Upload file
// ---------------------------------------------------------------------------

export async function uploadFile(
  sessionId: string,
  buffer: Buffer,
  originalname: string,
  mimetype: string,
  options: { directory?: string } = {}
) {
  log.info('Uploading file to session', {
    sessionId,
    originalname,
    sizeBytes: buffer.length,
    directory: options.directory,
  });

  const result = await uploadSessionFile(sessionId, buffer, originalname, mimetype, options);

  return {
    path: result.path,
    size: result.size,
    filename: originalname,
  };
}

// ---------------------------------------------------------------------------
// List files
// ---------------------------------------------------------------------------

export async function listFiles(sessionId: string) {
  log.info('Listing files for session', { sessionId });

  const files = await listProviderFiles(sessionId);

  return {
    session_id: sessionId,
    files,
    count: files.length,
  };
}

export async function downloadFile(sessionId: string, filePath: string, userId?: string) {
  await requireSessionOwner(sessionId, userId);
  validateSessionFilePath(filePath);
  const content = await readSessionFile(sessionId, filePath);
  const filename = filePath.split('/').pop();
  return {
    content,
    filename: filename !== undefined && filename !== '' ? filename : 'download',
  };
}

export async function takeScreenshot(sessionId: string, userId?: string) {
  await requireSessionOwner(sessionId, userId);
  return captureScreenshot(sessionId);
}

export async function pressKeys(sessionId: string, keys: string[], userId: string) {
  await requireSessionOwner(sessionId, userId);
  validateBrowserKeySymbols(keys);
  return pressSessionKeys(sessionId, keys);
}
/* c8 ignore stop */
