/**
 * Agent attachment service — legacy per-agent uploads and signed-URL access.
 */

import { processUploadedFile, getSignedUrl } from '../../providers/storage';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';

const log = createLogger('Agents');

// ---------------------------------------------------------------------------
// File uploads (deprecated - use /api/upload)
// ---------------------------------------------------------------------------

/** Upload a file attachment for an agent. */
export async function uploadAttachment(
  userId: string,
  agentId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string }
) {
  const filePointer = await processUploadedFile(
    userId,
    file.buffer,
    file.originalname,
    file.mimetype
  );

  log.info('Uploaded file', {
    user_id: userId,
    filename: filePointer.original_filename,
    size_bytes: filePointer.size_bytes,
    agent_id: agentId,
  });

  return { file_pointer: filePointer };
}

/** True when the requester may mint a signed URL for this storage path. */
export function canAccessAttachmentPath(args: {
  requesterUserId: string;
  storagePath: string;
  agentOwnerUserId?: string;
  isAdmin: boolean;
}): boolean {
  if (args.storagePath.startsWith(`${args.requesterUserId}/`)) {
    return true;
  }
  // Admins can inspect other users' agents (same as GET /agents/:id) but may
  // only sign files stored under that agent's owner — not arbitrary prefixes.
  return (
    args.isAdmin &&
    typeof args.agentOwnerUserId === 'string' &&
    args.agentOwnerUserId.length > 0 &&
    args.storagePath.startsWith(`${args.agentOwnerUserId}/`)
  );
}

/** Get a signed URL for a file attachment. */
export async function getAttachmentSignedUrl(
  userId: string,
  storagePath: string,
  access: { agentId?: string; isAdmin?: boolean } = {}
) {
  let agentOwnerUserId: string | undefined;
  if (access.isAdmin === true && typeof access.agentId === 'string' && access.agentId.length > 0) {
    const agent = await repo.findAgentById(access.agentId);
    agentOwnerUserId = agent?.userId;
  }
  if (
    !canAccessAttachmentPath({
      requesterUserId: userId,
      storagePath,
      agentOwnerUserId,
      isAdmin: access.isAdmin === true,
    })
  ) {
    return { error: 'Access denied to this file', status: 403 };
  }

  // Generate signed URL (1 hour expiry)
  const signedUrl = await getSignedUrl(storagePath, 3600);

  return {
    signed_url: signedUrl,
    expires_in: 3600,
  };
}
