/**
 * Shared file-pointer → LLM content blocks for chat router and generator.
 */

import { downloadFromStorage } from '../storage';
import { createLogger } from '../logger';

const log = createLogger('ChatMultimodal');

/** Same wording as AUTO_CAPTURED_SCREENSHOT_NOTE in agents/helpers/attachments.py. */
export const AUTO_CAPTURED_SCREENSHOT_NOTE =
  "Rose captured this screenshot of the user's screen automatically when they opened the " +
  'quick launcher; the user did not choose to attach it, and it may not be relevant to their request.';

export interface FilePointer {
  id: string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  auto_captured?: boolean;
}

export type MultimodalContentBlock = {
  type: string;
  text?: string;
  image_url?: { url: string };
  file?: { filename: string; file_data: string };
};

const LLM_INLINE_THRESHOLD = 20 * 1024 * 1024;

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
  'application/json',
  'application/xml',
]);

/** Runtime validation — DB JSON must match before we download or inline. */
export function isValidFilePointer(value: unknown): value is FilePointer {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.storage_path === 'string' &&
    v.storage_path.length > 0 &&
    typeof v.mime_type === 'string' &&
    v.mime_type.length > 0 &&
    typeof v.size_bytes === 'number' &&
    Number.isFinite(v.size_bytes) &&
    v.size_bytes >= 0 &&
    typeof v.original_filename === 'string'
  );
}

export async function buildMultimodalContentFromFile(
  text: string,
  filePointer: FilePointer
): Promise<MultimodalContentBlock[]> {
  const content: MultimodalContentBlock[] = [];

  if (filePointer.size_bytes >= LLM_INLINE_THRESHOLD) {
    const sizeStr = (filePointer.size_bytes / 1024 / 1024).toFixed(1);
    content.push({
      type: 'text',
      text: text
        ? `${text}\n\n[Attached: ${filePointer.original_filename} (${sizeStr}MB) - too large for inline viewing]`
        : `[Attached: ${filePointer.original_filename} (${sizeStr}MB) - too large for inline viewing]`,
    });
    return content;
  }

  try {
    const fileBuffer = await downloadFromStorage(filePointer.storage_path);
    const base64 = fileBuffer.toString('base64');

    if (IMAGE_MIME_TYPES.has(filePointer.mime_type)) {
      if (text) {
        content.push({ type: 'text', text });
      }
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${filePointer.mime_type};base64,${base64}`,
        },
      });
      if (filePointer.auto_captured === true) {
        content.push({ type: 'text', text: `[${AUTO_CAPTURED_SCREENSHOT_NOTE}]` });
      }
    } else if (
      TEXT_MIME_TYPES.has(filePointer.mime_type) ||
      filePointer.mime_type.startsWith('text/')
    ) {
      const decoded = fileBuffer.toString('utf-8');
      content.push({
        type: 'text',
        text: text
          ? `${text}\n\n[File: ${filePointer.original_filename}]\n\`\`\`\n${decoded}\n\`\`\``
          : `[File: ${filePointer.original_filename}]\n\`\`\`\n${decoded}\n\`\`\``,
      });
    } else if (filePointer.mime_type === 'application/pdf') {
      if (text) {
        content.push({ type: 'text', text });
      }
      content.push({
        type: 'file',
        file: {
          filename: filePointer.original_filename,
          file_data: `data:${filePointer.mime_type};base64,${base64}`,
        },
      });
    } else {
      content.push({
        type: 'text',
        text: text
          ? `${text}\n\n[Attached: ${filePointer.original_filename} (${filePointer.mime_type})]`
          : `[Attached: ${filePointer.original_filename} (${filePointer.mime_type})]`,
      });
    }
  } catch (error) {
    log.error('[ChatMultimodal] Failed to download file from storage', {
      error: error instanceof Error ? error.message : String(error),
    });
    content.push({
      type: 'text',
      text: text
        ? `${text}\n\n[Attached: ${filePointer.original_filename} - failed to load]`
        : `[Attached: ${filePointer.original_filename} - failed to load]`,
    });
  }

  return content;
}
