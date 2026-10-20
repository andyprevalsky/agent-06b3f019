/**
 * rose_user_ui publishing: validate a bundle, store it as an immutable
 * version, move the user's active pointer, and serve published files.
 *
 *   POST /versions ─► decode ─► validateUserUiBundle ─► store files ─► row (+activate)
 *   GET  /active   ─► User.activeUiVersionId ─► { versionId, manifest, baseUrl }
 *   GET  /bundle   ─► active version files, or the starting bundle (`rose-ui pull`)
 *   GET  /usercontent/:versionId/<path> ─► storage bytes (no auth; uuid id)
 *
 * 10k-agent behaviour: one pointer row per user; publishing is per-user and
 * rare; asset reads are immutable/CDN-cacheable and resolve owner via an
 * in-process cache, so there is no per-agent fan-in.
 */
import {
  USER_UI_BUILTIN_APP_ID,
  isSafeUserUiPath,
  userUiContentType,
  validateUserUiBundle,
  type UserUiBundleFile,
} from '../../providers/userUi/manifest';
import { findLatestRosePreview } from '../../providers/codePreview/service';
import { isRoseDevUser } from '../../utils/roseDevAccess';
import { getDisplayObject } from '../../providers/agentTools/media';
import { broadcastUserUiActiveChanged } from '../../providers/chat/supabaseBroadcast';
import { createLogger } from '../../providers/logger';
import { mintUserUiPublishToken } from '../../providers/userUi/publishToken';
import { userUiSeedFiles } from '../../providers/userUi/seed';
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

/**
 * The bundle `rose-ui pull` writes into a code session: the active version's
 * files (the same read that restores a version), or the starting bundle when
 * the user has published nothing yet. One read per pull; files are base64 and
 * bounded by the publish limits (50 MB, 2000 files).
 */
export async function getBundle(userId: string) {
  const active = await repo.findActiveUserUiVersion(userId);
  const files = active ? await repo.readUserUiVersionFiles(userId, active.id) : userUiSeedFiles();
  return {
    versionId: active?.id ?? null,
    source: active ? ('active' as const) : ('seed' as const),
    files: files.map((file) => ({
      path: file.path,
      contentBase64: file.content.toString('base64'),
    })),
  };
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

/** One row of the left-bar Apps section (A2). */
export type UserAppEntry =
  | {
      id: typeof USER_UI_BUILTIN_APP_ID;
      kind: 'builtin';
      title: 'Rose';
      /** Rose ships through /deploy; there is no published Rose URL. */
      url: null;
      /** Live HMR preview of the newest Rose-repo code session, when one exists. */
      preview_url: string | null;
      task_id: string | null;
      code_session_id: string | null;
      /** Publish opens a pull request (POST /api/claude-code-session/:taskId/publish). */
      publish: 'pull_request';
    }
  | {
      id: string;
      kind: 'user';
      title: string;
      /** Published entry on usercontent: this version's per-user URL. */
      url: string;
      icon_url: string | null;
      version_id: string;
      /** Publish is `rose-ui publish` (a new version); restore = activate an older one. */
      publish: 'usercontent';
    };

/**
 * GET /api/user-ui/apps: Rose first (dev accounts only), then the apps in the
 * active version's rose-ui.json. History/restore reuse GET /versions (each
 * version's manifest lists its apps) and POST /versions/:id/activate.
 */
export async function listApps(userId: string, requestOrigin: string) {
  const apps: UserAppEntry[] = [];
  if (isRoseDevUser(userId)) {
    const preview = await findLatestRosePreview(userId);
    apps.push({
      id: USER_UI_BUILTIN_APP_ID,
      kind: 'builtin',
      title: 'Rose',
      url: null,
      preview_url: preview?.preview_url ?? null,
      task_id: preview?.task_id ?? null,
      code_session_id: preview?.code_session_id ?? null,
      publish: 'pull_request',
    });
  }
  const active = await repo.findActiveUserUiVersion(userId);
  if (active) {
    const base = usercontentBaseUrl(requestOrigin, active.id);
    for (const [slug, app] of Object.entries(active.manifest.apps ?? {})) {
      apps.push({
        id: slug,
        kind: 'user',
        title: app.title,
        url: `${base}${app.entry}`,
        icon_url: app.icon !== undefined && app.icon !== '' ? `${base}${app.icon}` : null,
        version_id: active.id,
        publish: 'usercontent',
      });
    }
  }
  return { activeVersionId: active?.id ?? null, apps };
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
