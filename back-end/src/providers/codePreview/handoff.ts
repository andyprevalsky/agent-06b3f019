/**
 * One-time preview sign-in (Rose-in-Rose A1 follow-up, L-APPS2).
 *
 * A code agent's preview (`https://5173-<sandbox>.<domain>/`, or a loopback
 * port for local/Mac sessions) runs the Rose front-end. It proxies /api to this
 * backend but has no session on its origin, so the owner signs it in once:
 *
 *   Rose app (owner's real session)
 *     POST /api/claude-code-session/:taskId/preview/handoff
 *       ─► mintPreviewHandoff: dev account + owned task + real user JWT
 *          origin := origin(resolved preview URL)          (server-side only)
 *          PreviewHandoffCode {sha256(code), userId, taskId, origin, +60 s}
 *       ◄─ { code, expires_at, preview_url }
 *   opens  <preview_url>#rose_preview_handoff=<code>
 *   preview front-end (lib/previewHandoff.ts, before analytics starts)
 *     strips the fragment, POST /api/preview-handoff/redeem { code }
 *       ─► redeemPreviewHandoff: burn (redeemedAt null → now) FIRST, then
 *          expiry, then Origin == bound origin, then still a dev account
 *       ◄─ 8 h non-refreshable session (amr: preview_handoff) ─► storeSession()
 *
 * Threat model:
 *  - Replay: a code is 256 random bits, valid 60 s, single-use (one conditional
 *    UPDATE wins across every backend instance), stored only as SHA-256.
 *  - Origin binding: the origin comes from the task's resolved preview URL,
 *    never from client input; a redeem from any other Origin burns the code.
 *  - Fragment theft: a URL fragment is never sent to a server or in Referer; the
 *    front-end strips it before dev logging/analytics start.
 *  - Log leakage: code and tokens travel only in POST bodies/responses (no
 *    query strings); logs carry ids only.
 *  - Residual risk: code running in the preview origin (the agent's dev server)
 *    can read the redeemed session. Hence 8 h, no refresh, dev accounts only,
 *    and a preview session cannot mint another handoff.
 *
 * 10k-agent behaviour: minting is a user action (one indexed delete of the
 * user's expired codes + one insert); redeem is one conditional update, one
 * unique read and one user read. Nothing is polled, cached or broadcast.
 */
import crypto from 'crypto';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { generatePreviewHandoffSession, type SessionTokens } from '../sessionTokens';
import { ROSE_DEV_ONLY_BODY, isRoseDevUser } from '../../utils/roseDevAccess';
import { findOwnedTaskPreviewTarget } from './service';

const log = createLogger('PreviewHandoff');

/** A minted code is redeemable for this long. */
export const PREVIEW_HANDOFF_CODE_TTL_MS = 60_000;
/** URL fragment key the preview front-end reads (`#rose_preview_handoff=<code>`). */
export const PREVIEW_HANDOFF_FRAGMENT = 'rose_preview_handoff';

export class PreviewHandoffError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Origins a preview can be served from: an E2B port host
 * (`https://<port>-<sandbox>.<E2B_DOMAIN | e2b.app | e2b.dev>`) or loopback
 * (local and Mac sessions). Only these get CORS on the redeem route.
 */
export function isPreviewOrigin(origin: string | undefined): boolean {
  if (typeof origin !== 'string' || origin === '') return false;
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/.test(origin)) return true;
  const domains = ['e2b.app', 'e2b.dev'];
  const configured = (process.env.E2B_DOMAIN ?? '').trim().toLowerCase();
  if (configured !== '') domains.push(configured);
  const match = /^https:\/\/\d{1,5}-[a-z0-9]+\.(.+)$/.exec(origin.toLowerCase());
  return match !== null && domains.includes(match[1]);
}

export interface MintedPreviewHandoff {
  code: string;
  expires_at: string;
  preview_url: string;
}

/**
 * Mint a 60 s single-use code for the caller's own task preview. The route has
 * already required a dev account and a real user session; null = not the
 * caller's task (404).
 */
export async function mintPreviewHandoff(
  userId: string,
  taskId: string
): Promise<MintedPreviewHandoff | null> {
  const target = await findOwnedTaskPreviewTarget(userId, taskId);
  if (target === null) return null;
  const origin = target.preview_url !== null ? originOf(target.preview_url) : null;
  if (target.preview_url === null || origin === null) {
    throw new PreviewHandoffError(
      409,
      'PREVIEW_UNAVAILABLE',
      'This code agent has no preview to sign in to yet'
    );
  }
  const now = new Date();
  // Expired codes can never redeem; drop the caller's (bounded by their index).
  await prisma.previewHandoffCode.deleteMany({ where: { userId, expiresAt: { lt: now } } });
  const code = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + PREVIEW_HANDOFF_CODE_TTL_MS);
  const row = await prisma.previewHandoffCode.create({
    data: { codeHash: hashCode(code), userId, taskId, origin, expiresAt },
    select: { id: true },
  });
  log.info('Minted preview handoff code', { userId, taskId, handoffId: row.id, origin });
  return { code, expires_at: expiresAt.toISOString(), preview_url: target.preview_url };
}

export interface RedeemedPreviewHandoff extends SessionTokens {
  user: { id: string; phone: string | null };
}

/**
 * Exchange a code for an 8 h preview session. The first presentation burns the
 * code whatever happens next, so a wrong origin or an expired code cannot be
 * retried. `origin` is the request's Origin header.
 */
export async function redeemPreviewHandoff(
  code: string,
  origin: string | undefined
): Promise<RedeemedPreviewHandoff> {
  const codeHash = hashCode(code);
  const now = new Date();
  const burned = await prisma.previewHandoffCode.updateMany({
    where: { codeHash, redeemedAt: null },
    data: { redeemedAt: now },
  });
  if (burned.count !== 1) {
    throw new PreviewHandoffError(401, 'PREVIEW_HANDOFF_INVALID', 'Unknown or already used code');
  }
  const row = await prisma.previewHandoffCode.findUnique({
    where: { codeHash },
    select: { id: true, userId: true, taskId: true, origin: true, expiresAt: true },
  });
  if (row === null) {
    throw new PreviewHandoffError(401, 'PREVIEW_HANDOFF_INVALID', 'Unknown or already used code');
  }
  const ids = { handoffId: row.id, userId: row.userId, taskId: row.taskId };
  if (row.expiresAt.getTime() <= now.getTime()) {
    log.warn('Refused expired preview handoff code', ids);
    throw new PreviewHandoffError(401, 'PREVIEW_HANDOFF_EXPIRED', 'This sign-in link expired');
  }
  if (origin !== row.origin) {
    log.warn('Refused preview handoff from another origin', { ...ids, origin: origin ?? null });
    throw new PreviewHandoffError(
      403,
      'PREVIEW_HANDOFF_ORIGIN_MISMATCH',
      'This sign-in link belongs to another preview'
    );
  }
  if (!isRoseDevUser(row.userId)) {
    throw new PreviewHandoffError(403, ROSE_DEV_ONLY_BODY.code, ROSE_DEV_ONLY_BODY.error);
  }
  const user = await prisma.user.findUnique({
    where: { userId: row.userId },
    select: { phone: true },
  });
  if (user === null) {
    throw new PreviewHandoffError(401, 'PREVIEW_HANDOFF_INVALID', 'Unknown or already used code');
  }
  const session = generatePreviewHandoffSession(row.userId, user.phone ?? '', {
    taskId: row.taskId,
  });
  log.info('Redeemed preview handoff code', ids);
  return { ...session, user: { id: row.userId, phone: user.phone } };
}
