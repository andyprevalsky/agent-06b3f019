import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { createLogger } from './logger';

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

    supabaseClient = createClient(supabaseUrl, supabaseServiceKey);
  }
  return supabaseClient;
}

const ATTACHMENT_BUCKET = 'attachments';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB per file
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB total per message

// All files are stored in Supabase Storage - no inline base64
export interface FilePointer {
  id: string;
  storage_path: string; // All files stored in storage
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

/**
 * Upload a file to Supabase Storage
 * Files are stored under userId for user-level permissions (not agent-scoped)
 */
export async function uploadToStorage(
  userId: string,
  fileBuffer: Buffer,
  filename: string,
  mimeType: string
): Promise<{ storage_path: string }> {
  const client = getSupabaseClient();
  const fileId = crypto.randomUUID();
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${userId}/${fileId}_${safeFilename}`;

  const { error } = await client.storage.from(ATTACHMENT_BUCKET).upload(storagePath, fileBuffer, {
    contentType: mimeType,
    upsert: false,
  });

  if (error) {
    log.error('Upload failed', { error: error.message });
    throw new Error(`Failed to upload file: ${error.message}`);
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

  return Buffer.from(await data.arrayBuffer());
}

/**
 * Generate a signed URL for a file (for frontend display of large files)
 */
export async function getSignedUrl(storagePath: string, expiresIn: number = 3600): Promise<string> {
  const client = getSupabaseClient();

  const { data, error } = await client.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(storagePath, expiresIn);

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
