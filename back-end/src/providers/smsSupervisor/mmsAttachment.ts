/**
 * MMS attachment re-hosting for lifecycle notifications: fetch the agent's image, bound its
 * size and type, and republish it from our storage under a signed URL the carrier can fetch.
 */
import { createLogger } from '../logger';
import { getSignedUrl, uploadToStorage } from '../storage';

const log = createLogger('OutboundEvents');

const MAX_MMS_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MMS_ATTACHMENT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

export async function rehostMmsAttachmentUrl(
  userId: string,
  mediaUrl: string
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(mediaUrl, {
      headers: {
        accept: 'image/*,*/*;q=0.8',
        'user-agent': 'Rose/1.0 MMS attachment fetcher',
      },
    });
  } catch (error) {
    log.warn('Failed to fetch MMS attachment before sending', {
      userId,
      mediaUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!response.ok) {
    log.warn('MMS attachment URL was not fetchable', {
      userId,
      mediaUrl,
      status: response.status,
    });
    return null;
  }

  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) {
    log.warn('MMS attachment URL did not return an image', {
      userId,
      mediaUrl,
      mimeType,
    });
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_MMS_ATTACHMENT_BYTES) {
    log.warn('MMS attachment size is invalid', {
      userId,
      mediaUrl,
      sizeBytes: buffer.length,
      maxBytes: MAX_MMS_ATTACHMENT_BYTES,
    });
    return null;
  }

  const filename = `write-lock-${Date.now()}.${extensionFromMimeType(mimeType)}`;
  const { storage_path: storagePath } = await uploadToStorage(userId, buffer, filename, mimeType);
  return getSignedUrl(storagePath, MMS_ATTACHMENT_SIGNED_URL_TTL_SECONDS);
}
