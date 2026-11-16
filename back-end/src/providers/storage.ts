import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { WebSocketLikeConstructor } from '@supabase/realtime-js';
import crypto from 'crypto';
import WebSocket from 'ws';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';
import { looksLikeUtf8ReplacementCorruption } from './fetchCapture';

const log = createLogger('Storage');

// Lazy initialization of Supabase client
let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable');
    }

    supabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
      realtime: {
        transport: WebSocket as unknown as WebSocketLikeConstructor,
      },
    });
  }
  return supabaseClient;
}

const ATTACHMENT_BUCKET = 'attachments';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB per file
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB total per message

function storageErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function storageErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;

  const candidate =
    (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  if (typeof candidate === 'number') return candidate;
  if (typeof candidate === 'string') {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRetryableStorageError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error && 'retryable' in error) {
    return Boolean((error as { retryable: unknown }).retryable);
  }

  const status = storageErrorStatus(error);
  if (status !== undefined && [408, 429, 500, 502, 503, 504].includes(status)) return true;

  const message = storageErrorMessage(error).toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('connection') ||
    message.includes('econnreset') ||
    message.includes('etimedout')
  );
}

function isAlreadyUploadedStorageError(error: unknown): boolean {
  // Supabase answers a duplicate with HTTP status 400 and statusCode "409" in the body.
  const codes = [
    storageErrorStatus(error),
    storageErrorStatus({ status: (error as { statusCode?: unknown } | null)?.statusCode }),
  ].filter((code) => code !== undefined);
  if (codes.length > 0 && !codes.includes(409)) return false;

  const message = storageErrorMessage(error).toLowerCase();
  return message.includes('already exists') || message.includes('resource already exists');
}

// All files are stored in Supabase Storage - no inline base64
export interface FilePointer {
  id: string;
  storage_path: string; // All files stored in storage
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  auto_captured?: boolean;
}

/**
 * Upload a file to Supabase Storage
 * Files are stored under userId for user-level permissions (not agent-scoped)
 */
export async function uploadToStorage(
  userId: string,
  fileBuffer: Buffer,
  filename: string,
  mimeType: string,
  options?: { objectId?: string }
): Promise<{ storage_path: string }> {
  const client = getSupabaseClient();
  const fileId = options?.objectId ?? crypto.randomUUID();
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(fileId)) {
    throw new Error('Storage object id contains invalid characters');
  }
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${userId}/${fileId}_${safeFilename}`;

  let error: unknown;
  try {
    const uploadResult = await retryWithBackoff(
      async () => {
        const result = await client.storage
          .from(ATTACHMENT_BUCKET)
          .upload(storagePath, fileBuffer, {
            contentType: mimeType,
            upsert: false,
          });

        if (result.error && isAlreadyUploadedStorageError(result.error)) {
          return { ...result, error: null };
        }

        if (result.error && isRetryableStorageError(result.error)) {
          throw result.error;
        }

        return result;
      },
      {
        maxRetries: 3,
        initialBackoffMs: 500,
        component: 'StorageUpload',
        isRetryable: isRetryableStorageError,
      }
    );
    error = uploadResult.error;
  } catch (caught) {
    error = caught;
  }

  if (error) {
    const message = storageErrorMessage(error);
    log.error('Upload failed', { error: message });
    throw new Error(`Failed to upload file: ${message}`);
  }

  log.info(`Uploaded file to ${storagePath} (${fileBuffer.length} bytes)`);

  return { storage_path: storagePath };
}

/**
 * Download a file from Supabase Storage
 */
export async function downloadFromStorage(storagePath: string): Promise<Buffer> {
  const client = getSupabaseClient();

  const { data, error } = await client.storage.from(ATTACHMENT_BUCKET).download(storagePath);

  if (error) {
    log.error('Download failed', { error: error.message });
    throw new Error(`Failed to download file: ${error.message}`);
  }

  const buf = Buffer.from(await data.arrayBuffer());
  // Last-line guard: fetchCapture used to UTF-8-corrupt binary bodies under
  // BLACKBOX_TEST_CAPTURE_OUTBOUND=1 (207364→369851 JPEG). Refuse to hand a
  // corrupted buffer to E2B so Claude Code never sees EF BF BD "images".
  if (looksLikeUtf8ReplacementCorruption(buf)) {
    log.error('Downloaded attachment looks UTF-8-corrupted; refusing to use bytes', {
      storagePath,
      size: buf.length,
    });
    throw new Error(
      `Downloaded attachment at ${storagePath} looks UTF-8-corrupted (${buf.length} bytes); ` +
        'refusing to upload to code-agent sandbox'
    );
  }
  return buf;
}

/**
 * Write an object at an exact storage path (immutable: never upserts). Used by
 * stores that own their own key layout, e.g. `user-ui/<userId>/<versionId>/…`.
 * An already-existing identical key is treated as success so retries are safe.
 */
export async function putStorageObject(
  storagePath: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const client = getSupabaseClient();
  await retryWithBackoff(
    async () => {
      const result = await client.storage
        .from(ATTACHMENT_BUCKET)
        .upload(storagePath, body, { contentType, upsert: false });
      if (result.error && !isAlreadyUploadedStorageError(result.error)) throw result.error;
    },
    {
      maxRetries: 3,
      initialBackoffMs: 500,
      component: 'StoragePutObject',
      isRetryable: isRetryableStorageError,
    }
  );
}

/** Read an object at an exact storage path; returns null when it does not exist. */
export async function getStorageObject(
  storagePath: string,
  signal?: AbortSignal
): Promise<Buffer | null> {
  const client = getSupabaseClient();
  const { data, error } = await client.storage
    .from(ATTACHMENT_BUCKET)
    .download(storagePath, {}, { signal });
  if (error) {
    const status = storageErrorStatus(error);
    const message = storageErrorMessage(error).toLowerCase();
    if (status === 400 || status === 404 || message.includes('not found')) return null;
    throw new Error(`Failed to download ${storagePath}: ${storageErrorMessage(error)}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

/**
 * An SVG opened as a page would run its scripts on the storage origin, so its
 * signed URL always downloads (Content-Disposition: attachment). An <img> still
 * renders it: images ignore Content-Disposition and never run SVG scripts.
 */
export function signedUrlOptions(storagePath: string): { download: true } | undefined {
  return /\.svg$/i.test(storagePath) ? { download: true } : undefined;
}

/**
 * Generate a signed URL for a file (for frontend display of large files)
 */
export async function getSignedUrl(storagePath: string, expiresIn: number = 3600): Promise<string> {
  const client = getSupabaseClient();

  const { data, error } = await client.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(storagePath, expiresIn, signedUrlOptions(storagePath));

  if (error) {
    log.error('Signed URL generation failed', { error: error.message });
    throw new Error(`Failed to generate signed URL: ${error.message}`);
  }

  return data.signedUrl;
}

/**
 * Delete a file from Supabase Storage
 */
export async function deleteFromStorage(storagePath: string): Promise<void> {
  const client = getSupabaseClient();

  const { error } = await client.storage.from(ATTACHMENT_BUCKET).remove([storagePath]);

  if (error) {
    log.error('Delete failed', { error: error.message });
    throw new Error(`Failed to delete file: ${error.message}`);
  }
}

/**
 * Process an uploaded file and create a FilePointer
 * All files are uploaded to Supabase Storage under userId (not agent-scoped)
 */
export async function processUploadedFile(
  userId: string,
  fileBuffer: Buffer,
  filename: string,
  mimeType: string
): Promise<FilePointer> {
  const fileId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Validate file size
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds maximum of ${MAX_FILE_SIZE / 1024 / 1024}MB`);
  }

  // Upload to Supabase Storage
  log.info(`Uploading file to storage: ${filename} (${fileBuffer.length} bytes)`);
  const { storage_path } = await uploadToStorage(userId, fileBuffer, filename, mimeType);

  return {
    id: fileId,
    storage_path,
    original_filename: filename,
    mime_type: mimeType,
    size_bytes: fileBuffer.length,
    created_at: now,
  };
}

/**
 * Validate total attachment size for a message
 */
export function validateTotalSize(attachments: FilePointer[]): void {
  const totalSize = attachments.reduce((sum, fp) => sum + fp.size_bytes, 0);
  if (totalSize > MAX_TOTAL_SIZE) {
    throw new Error(`Total attachment size exceeds maximum of ${MAX_TOTAL_SIZE / 1024 / 1024}MB`);
  }
}

/**
 * Get the content of a file pointer (download from storage)
 */
export async function getFileContent(filePointer: FilePointer): Promise<Buffer> {
  return downloadFromStorage(filePointer.storage_path);
}

export { MAX_FILE_SIZE, MAX_TOTAL_SIZE, ATTACHMENT_BUCKET };
