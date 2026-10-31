/**
 * Browser-session file, screenshot and key I/O against a live provider session.
 */

import { createLogger } from '../../providers/logger';
import {
  getSession,
  uploadSessionFile,
  listFiles as listProviderFiles,
  readSessionFile,
  captureScreenshot,
  pressSessionKeys,
} from '../../providers/browser';
import * as repo from './repo';
import { validateBrowserKeySymbols } from './service.browser-input';
import { SessionNotFoundError } from './service.local-storage';

const log = createLogger('BrowserSession');

async function requireSessionOwner(sessionId: string, userId?: string): Promise<void> {
  if (userId === undefined) return;
  const session = await repo.findSessionBySessionId(sessionId);
  if (session === null || session.context.userId !== userId) throw new SessionNotFoundError();
}

// ---------------------------------------------------------------------------
// Get session by Steel ID
// ---------------------------------------------------------------------------

/* c8 ignore start -- getSessionById, uploadFile, listFiles require Steel SDK */
export async function getSessionById(sessionId: string) {
  return getSession(sessionId);
}

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
  // Provider-bound validation uses the same stored provider as dispatch (R23).
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
