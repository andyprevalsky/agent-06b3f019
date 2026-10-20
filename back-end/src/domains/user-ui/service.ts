/**
 * rose_user_ui publishing: validate a bundle, store it as an immutable
 * version, move the user's active pointer, and serve published files.
 *
 *   POST /versions ─► decode ─► validateUserUiBundle ─► store files ─► row (+activate)
 *   GET  /active   ─► User.activeUiVersionId ─► { versionId, manifest, baseUrl }
 *   GET  /usercontent/:versionId/<path> ─► storage bytes (no auth; uuid id)
 *
 * 10k-agent behaviour: one pointer row per user; publishing is per-user and
 * rare; asset reads are immutable/CDN-cacheable and resolve owner via an
 * in-process cache, so there is no per-agent fan-in.
 */
import {
  isSafeUserUiPath,
  userUiContentType,
  validateUserUiBundle,
  type UserUiBundleFile,
} from '../../providers/userUi/manifest';
import { getDisplayObject } from '../../providers/agentTools/media';
import { broadcastUserUiActiveChanged } from '../../providers/chat/supabaseBroadcast';
import { createLogger } from '../../providers/logger';
import { mintUserUiPublishToken } from '../../providers/userUi/publishToken';
import { USER_UI_LIST_LIMIT, configuredUsercontentBaseUrl } from './config';
import * as repo from './repo';
import type { PublishUserUiVersionBody } from './types';

export class UserUiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[]
  ) {
    super(message);
  }
}

const log = createLogger('UserUiService');

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeFiles(body: PublishUserUiVersionBody): UserUiBundleFile[] {
  return body.files.map((file) => {
    if (file.contentBase64.length % 4 !== 0 || !BASE64_RE.test(file.contentBase64)) {
      throw new UserUiError(400, 'Invalid bundle', [
        `${file.path.slice(0, 200)} is not valid base64`,
      ]);
    }
    return { path: file.path, content: Buffer.from(file.contentBase64, 'base64') };
  });
}

/** Tell an open Rose tab that the active UI moved (best-effort, never throws). */
async function announceActiveChanged(userId: string, agentId: string, versionId: string) {
  try {
    const agentIds = await repo.userUiAnnounceAgentIds(userId, agentId);
    if (agentIds.length > 0) await broadcastUserUiActiveChanged(agentIds, { versionId, agentId });
  } catch (err) {
    log.warn('USER_UI_ACTIVE_CHANGED broadcast failed', {
      userId,
      agentId,
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function publishVersion(
  userId: string,
  body: PublishUserUiVersionBody,
  publisher: { agentId: string | null } = { agentId: null }
) {
  const files = decodeFiles(body);
  const validation = validateUserUiBundle(files);
  if (!validation.ok) throw new UserUiError(400, 'Invalid bundle', validation.errors);
  if (!(await repo.userExists(userId))) throw new UserUiError(404, 'User not found');
  const version = await repo.createUserUiVersion({
    userId,
    files,
    manifest: validation.manifest,
    totalBytes: validation.totalBytes,
    activate: body.activate !== false,
  });
  if (body.activate !== false && publisher.agentId !== null) {
    await announceActiveChanged(userId, publisher.agentId, version.id);
  }
  return { versionId: version.id, manifest: version.manifest, active: body.activate !== false };
}

export async function activateVersion(userId: string, versionId: string) {
  if (!(await repo.activateUserUiVersion(userId, versionId))) {
    throw new UserUiError(404, 'Version not found');
  }
  return { versionId, active: true };
}

export function usercontentBaseUrl(requestOrigin: string, versionId: string): string {
  return `${configuredUsercontentBaseUrl() ?? requestOrigin}/usercontent/${versionId}/`;
}

export async function getActive(userId: string, requestOrigin: string) {
  const active = await repo.findActiveUserUiVersion(userId);
  if (!active) return { versionId: null };
  return {
    versionId: active.id,
    manifest: active.manifest,
    baseUrl: usercontentBaseUrl(requestOrigin, active.id),
  };
}

export async function listVersions(userId: string) {
  const { activeVersionId, versions } = await repo.listUserUiVersions(userId, USER_UI_LIST_LIMIT);
  return {
    activeVersionId,
    versions: versions.map((v) => ({
      versionId: v.id,
      manifest: v.manifest,
      fileCount: v.fileCount,
      totalBytes: v.totalBytes,
      createdAt: v.createdAt.toISOString(),
      active: v.id === activeVersionId,
    })),
  };
}

export function mintPublishToken(userId: string) {
  const { token, expiresAt } = mintUserUiPublishToken(userId);
  return { token, expiresAt, scope: 'user-ui:publish' };
}

/** Bytes + content type for a published file; null when not found. */
export async function readUsercontent(versionId: string, path: string) {
  if (!isSafeUserUiPath(path)) return null;
  const content = await repo.readUserUiFile(versionId, path);
  return content ? { content, contentType: userUiContentType(path) } : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DISPLAY_HTML_RE = /^[0-9a-f]{64}\.html$/;

/** A `display` HTML page by (agent, content hash); null when not found. */
export async function readDisplayHtml(agentId: string, file: string): Promise<Buffer | null> {
  if (!UUID_RE.test(agentId) || !DISPLAY_HTML_RE.test(file)) return null;
  const ownerId = await repo.findAgentOwnerId(agentId);
  return ownerId === null ? null : getDisplayObject(`${ownerId}/display/${file}`);
}
