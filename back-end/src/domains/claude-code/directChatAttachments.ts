import { downloadFromStorage } from '../../providers/storage';
import type { CodeTurnAttachment } from '../../providers/codeSessionTurns';

export interface DirectAttachment {
  original_filename: string;
  mime_type: string;
  storage_path?: string;
  size_bytes: number;
}

/** Owner check precedes every service-key read; verify declared and actual size. */
export async function prepareDirectTurnAttachments(
  pointers: DirectAttachment[] | undefined,
  userId: string
): Promise<CodeTurnAttachment[]> {
  const attachments: CodeTurnAttachment[] = [];
  let totalBytes = 0;
  for (const attachment of pointers ?? []) {
    const path = attachment.storage_path;
    if (
      path === undefined ||
      !path.startsWith(`${userId}/`) ||
      path.split('/').some((part) => part === '..' || part === '.')
    ) {
      throw new Error('INVALID_ATTACHMENT');
    }
    if (attachment.size_bytes > 20 * 1024 * 1024) throw new Error('ATTACHMENTS_TOO_LARGE');
    const content = await downloadFromStorage(path);
    totalBytes += content.length;
    if (content.length > 20 * 1024 * 1024 || totalBytes > 100 * 1024 * 1024) {
      throw new Error('ATTACHMENTS_TOO_LARGE');
    }
    attachments.push({
      name: attachment.original_filename,
      mime_type: attachment.mime_type,
      base64_data: content.toString('base64'),
    });
  }
  return attachments;
}
