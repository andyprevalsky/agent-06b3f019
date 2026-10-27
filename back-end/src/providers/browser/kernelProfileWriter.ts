/**
 * One writer per Kernel profile.
 *
 * Kernel docs: "Only one browser can safely write to a profile at a time" and
 * "Saving replaces the complete profile; it doesn't merge state from multiple
 * browsers." A user's concurrent browser agents share one Kernel profile
 * (BrowserContext is unique per user), so before this every one of them was
 * created with save_changes: true and the last delete overwrote the others.
 *
 *   create(profile P)
 *     ├─ claim writer row (P) ── won ──► save_changes: true ─► bind row to sessionId
 *     │        │                                                  │
 *     │        └─ held by S ── S is the session being replaced ──►┤ (handoff: row moves
 *     │                    │                       only on bind; a failed swap restores S)
 *     │                    ├─ S no longer exists on Kernel ──────►┤ (take over)
 *     │                    └─ S live / create pending ──► save_changes: false (reads P)
 *     └─ release(sessionId) after its DELETE (Kernel saves on delete) frees the row
 *
 * State lives in SharedEphemeralState (namespace per role), keyed per profile
 * and per session: O(1) rows and primary-key lookups per browser, independent
 * of how many agents or instances exist. A writer that vanished without a
 * release is detected by one Kernel GET on the contended path only; the TTL
 * (Kernel's maximum session lifetime) is a backstop.
 */
import { randomUUID } from 'node:crypto';
import { NotFoundError } from '@onkernel/sdk';
import { prisma } from '../database';
import { kernelClient } from './kernelClient';
import { KERNEL_CREATE_REQUEST_OPTIONS } from './kernelProxy';
import { createLogger } from '../logger';

const log = createLogger('KernelProfileWriter');

const WRITER_NAMESPACE = 'kernel-profile-writer';
const SESSION_NAMESPACE = 'kernel-profile-writer-session';
/** Kernel's maximum timeout_seconds (72h): no live session can outlast it. */
const WRITER_TTL_MS = 259_200_000;
/** A claim whose create never bound a session within this window is abandoned. */
const PENDING_CREATE_STALE_MS = 10 * 60_000;

interface WriterValue {
  token: string;
  sessionId: string | null;
}

export interface KernelProfileWriterClaim {
  profileId: string;
  /** True when this browser must be created with save_changes: true. */
  writer: boolean;
  token: string | null;
  /** Set on a rotate/resume handoff: the replaced writer, which still owns the row until bind. */
  handoffFrom?: string;
}

interface SessionIndexValue {
  profileId: string;
  token: string;
  handoffFrom?: string;
}

/** Whether a Kernel browser session still exists; false only on a definite not-found. */
export type KernelSessionExists = (sessionId: string) => Promise<boolean>;

async function kernelSessionExists(sessionId: string): Promise<boolean> {
  try {
    await kernelClient().browsers.retrieve(sessionId, {}, KERNEL_CREATE_REQUEST_OPTIONS);
    return true;
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    log.warn('Could not confirm the Kernel profile writer is gone; treating it as live', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

async function insertOrTakeExpired(profileId: string, value: WriterValue): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ key: string }>>`
    INSERT INTO "SharedEphemeralState" (namespace, key, value, "expiresAt")
    VALUES (${WRITER_NAMESPACE}, ${profileId}, ${JSON.stringify(value)}::jsonb,
            now() + ${WRITER_TTL_MS} * interval '1 millisecond')
    ON CONFLICT (namespace, key) DO UPDATE
      SET value = EXCLUDED.value, "expiresAt" = EXCLUDED."expiresAt", "createdAt" = now()
      WHERE "SharedEphemeralState"."expiresAt" <= now()
    RETURNING key
  `;
  return rows.length === 1;
}

/** Compare-and-swap the writer row from the observed holder token to a new claim. */
async function replaceHolder(profileId: string, holderToken: string, value: WriterValue) {
  const count = await prisma.$executeRaw`
    UPDATE "SharedEphemeralState"
    SET value = ${JSON.stringify(value)}::jsonb, "createdAt" = now(),
        "expiresAt" = now() + ${WRITER_TTL_MS} * interval '1 millisecond'
    WHERE namespace = ${WRITER_NAMESPACE} AND key = ${profileId}
      AND value->>'token' = ${holderToken}
  `;
  return count === 1;
}

async function readHolder(
  profileId: string
): Promise<{ value: WriterValue; ageMs: number } | null> {
  const rows = await prisma.$queryRaw<Array<{ value: WriterValue; ageMs: number }>>`
    SELECT value, (EXTRACT(EPOCH FROM (now() - "createdAt")) * 1000)::float8 AS "ageMs"
    FROM "SharedEphemeralState"
    WHERE namespace = ${WRITER_NAMESPACE} AND key = ${profileId} AND "expiresAt" > now()
  `;
  return rows[0] ?? null;
}

/**
 * Decide whether a new browser on `profileId` may write it. `replacingSessionId`
 * is the session a rotate/resume recreate supersedes: its writer role moves to
 * the replacement (the old browser is deleted right after).
 */
export async function claimKernelProfileWriter(
  profileId: string | null,
  replacingSessionId?: string | null,
  sessionExists: KernelSessionExists = kernelSessionExists
): Promise<KernelProfileWriterClaim> {
  // A profile-less (ephemeral) browser has nothing to save.
  if (profileId === null) return { profileId: '', writer: false, token: null };
  const token = randomUUID();
  const claim: WriterValue = { token, sessionId: null };
  if (await insertOrTakeExpired(profileId, claim)) {
    return { profileId, writer: true, token };
  }
  const holder = await readHolder(profileId);
  if (holder === null) {
    // Released between our insert and read: one more insert settles it.
    const won = await insertOrTakeExpired(profileId, claim);
    return { profileId, writer: won, token: won ? token : null };
  }
  const heldBy = holder.value.sessionId;
  let takeOver = false;
  let reason = '';
  if (heldBy !== null && heldBy === replacingSessionId) {
    // Leave the row with the replaced writer until the replacement binds, so a
    // failed swap leaves the still-live old browser as the tracked writer.
    log.info('Kernel profile writer handed off to replacement', { profileId, from: heldBy });
    return { profileId, writer: true, token: holder.value.token, handoffFrom: heldBy };
  }
  if (heldBy === null) {
    takeOver = holder.ageMs > PENDING_CREATE_STALE_MS;
    reason = 'abandoned_pending_create';
  } else if (!(await sessionExists(heldBy))) {
    takeOver = true;
    reason = 'writer_session_gone';
  }
  if (takeOver && (await replaceHolder(profileId, holder.value.token, claim))) {
    log.info('Kernel profile writer taken over', { profileId, previousSessionId: heldBy, reason });
    if (heldBy !== null) await dropSessionIndex(heldBy);
    return { profileId, writer: true, token };
  }
  log.info('Kernel profile already has a writer; new browser reads it without saving', {
    profileId,
    writerSessionId: heldBy,
  });
  return { profileId, writer: false, token: null };
}

/**
 * Record which Kernel session holds the writer claim, so its release frees the
 * profile. If recording fails, the just-created browser is deleted: an
 * untracked writer would let a second browser write the same profile.
 */
export async function bindKernelProfileWriter(
  claim: KernelProfileWriterClaim,
  remote: { sessionId: string; validationBrowser: { close(): Promise<void> } },
  releaseRemote: (sessionId: string) => Promise<void>
): Promise<void> {
  try {
    await bindWriterRows(claim, remote.sessionId);
  } catch (error) {
    await Promise.allSettled([releaseRemote(remote.sessionId), remote.validationBrowser.close()]);
    throw error;
  }
}

async function bindWriterRows(claim: KernelProfileWriterClaim, sessionId: string): Promise<void> {
  if (!claim.writer || claim.token === null) return;
  const value: WriterValue = { token: claim.token, sessionId };
  const bound = await prisma.$executeRaw`
    UPDATE "SharedEphemeralState" SET value = ${JSON.stringify(value)}::jsonb
    WHERE namespace = ${WRITER_NAMESPACE} AND key = ${claim.profileId}
      AND value->>'token' = ${claim.token}
  `;
  if (bound !== 1) {
    log.warn('Kernel profile writer claim was taken over before its session bound', {
      profileId: claim.profileId,
      sessionId,
    });
    return;
  }
  await prisma.$executeRaw`
    INSERT INTO "SharedEphemeralState" (namespace, key, value, "expiresAt")
    VALUES (${SESSION_NAMESPACE}, ${sessionId},
            ${JSON.stringify(sessionIndexValue(claim))}::jsonb,
            now() + ${WRITER_TTL_MS} * interval '1 millisecond')
    ON CONFLICT (namespace, key) DO UPDATE
      SET value = EXCLUDED.value, "expiresAt" = EXCLUDED."expiresAt"
  `;
}

function sessionIndexValue(claim: KernelProfileWriterClaim): SessionIndexValue {
  return {
    profileId: claim.profileId,
    token: claim.token ?? '',
    ...(claim.handoffFrom !== undefined ? { handoffFrom: claim.handoffFrom } : {}),
  };
}

/** Give up a claim whose browser was never created (best effort: the claim also goes stale). */
export async function abandonKernelProfileWriterClaim(
  claim: KernelProfileWriterClaim
): Promise<void> {
  // A handoff never moved the row before bind: the replaced writer still owns it.
  if (!claim.writer || claim.token === null || claim.handoffFrom !== undefined) return;
  await prisma.$executeRaw`
    DELETE FROM "SharedEphemeralState"
    WHERE namespace = ${WRITER_NAMESPACE} AND key = ${claim.profileId}
      AND value->>'token' = ${claim.token}
  `.catch((error: unknown) =>
    log.warn('Failed to abandon Kernel profile writer claim; it goes stale on its own', {
      profileId: claim.profileId,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

async function dropSessionIndex(sessionId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "SharedEphemeralState" WHERE namespace = ${SESSION_NAMESPACE} AND key = ${sessionId}
  `;
}

/**
 * Free the profile after `sessionId` was deleted (Kernel persists the writer's
 * state on delete). A no-op for reader sessions and for writers already handed
 * off. If this was a replacement whose swap failed while the browser it replaced
 * is still tracked, the writer role returns to that browser instead.
 */
export async function releaseKernelProfileWriter(sessionId: string): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ value: SessionIndexValue }>>`
    DELETE FROM "SharedEphemeralState"
    WHERE namespace = ${SESSION_NAMESPACE} AND key = ${sessionId}
    RETURNING value
  `;
  const entry = rows[0]?.value;
  if (entry === undefined) return;
  const previous = entry.handoffFrom;
  if (previous !== undefined) {
    const restored = await prisma.$executeRaw`
      UPDATE "SharedEphemeralState"
      SET value = ${JSON.stringify({ token: entry.token, sessionId: previous })}::jsonb
      WHERE namespace = ${WRITER_NAMESPACE} AND key = ${entry.profileId}
        AND value->>'token' = ${entry.token} AND value->>'sessionId' = ${sessionId}
        AND EXISTS (
          SELECT 1 FROM "SharedEphemeralState" idx
          WHERE idx.namespace = ${SESSION_NAMESPACE} AND idx.key = ${previous}
        )
    `;
    if (restored === 1) {
      log.warn('Kernel profile writer returned to the browser a failed swap replaced', {
        profileId: entry.profileId,
        sessionId: previous,
      });
      return;
    }
  }
  await prisma.$executeRaw`
    DELETE FROM "SharedEphemeralState"
    WHERE namespace = ${WRITER_NAMESPACE} AND key = ${entry.profileId}
      AND value->>'token' = ${entry.token} AND value->>'sessionId' = ${sessionId}
  `;
}
