/**
 * Cross-instance view of connect sessions.
 *
 *   owner instance (holds the live browser + CDP)      any other instance
 *   ─────────────────────────────────────────────      ──────────────────────────
 *   mirror tick (1s) ── putEphemeral(snapshot) ──────► poll reads the snapshot
 *   mirror tick      ◄─ takeEphemeral(cancel) ──────── cancel files a request
 *        └─► finish(entry): release the browser
 *
 * A connect session owns a remote browser and a CDP socket, so it can only run
 * on the instance that started it. Poll and cancel arrive on whichever instance
 * the load balancer picks; the mirror makes both work from anywhere. One row
 * write per live connect session per second, independent of instance count.
 */

import { getEphemeral, putEphemeral, takeEphemeral } from '../../providers/sharedState';
import { createLogger } from '../../providers/logger';
import { finish } from './connectSession.lifecycle';
import { pending } from './connectSession.state';
import type { ConnectStage, PendingConnect } from './connectSession.types';

const log = createLogger('ComputeConnect');

const SNAPSHOT_NAMESPACE = 'compute-connect';
const CANCEL_NAMESPACE = 'compute-connect-cancel';
const MIRROR_INTERVAL_MS = 1_000;
/** Long enough to outlive the done-hold window plus a few missed ticks. */
const SNAPSHOT_TAIL_MS = 3 * 60 * 1000;
const CANCEL_TTL_MS = 5 * 60 * 1000;

export type ConnectPollState = 'pending' | 'connected' | 'expired' | 'unknown';

export interface ConnectPollResult {
  stage?: ConnectStage;
  /** Sent once the cloud browser has booted; null while still provisioning. */
  liveViewUrl?: string | null;
  state: ConnectPollState;
  accountEmail?: string;
  accountId?: string;
  reason?: string;
}

interface ConnectSnapshot {
  userId: string;
  result: ConnectPollResult;
}

/** Status of a live entry. Pure: never touches the remote browser. */
export function pollResultFor(entry: PendingConnect, now = Date.now()): ConnectPollResult {
  if (entry.done) {
    return { state: 'connected', accountEmail: entry.accountEmail, accountId: entry.accountId };
  }
  if (entry.failed !== undefined) return { state: 'unknown', reason: entry.failed };
  if (now > entry.deadline) return { state: 'expired', reason: 'sign-in window elapsed' };
  return {
    state: 'pending',
    stage: entry.stage,
    liveViewUrl: entry.liveViewUrl,
    // Known as soon as the seeded session identifies itself, so the modal can
    // show WHICH account is being connected while the user is still working.
    accountEmail: entry.accountEmail,
  };
}

async function publish(entry: PendingConnect, result: ConnectPollResult): Promise<void> {
  const ttl = Math.max(entry.deadline - Date.now(), 0) + SNAPSHOT_TAIL_MS;
  const snapshot: ConnectSnapshot = { userId: entry.userId, result };
  await putEphemeral(SNAPSHOT_NAMESPACE, entry.connectId, snapshot as never, ttl);
}

/**
 * Mirror a locally-owned connect session for other instances until it leaves
 * `pending`, and apply cancel requests they filed.
 */
export function startSharedMirror(entry: PendingConnect): () => void {
  let stopped = false;
  let ticking = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      if (pending.get(entry.connectId) !== entry) {
        // Finished, cancelled or reaped here: publish the final state once.
        await publish(entry, entry.done ? pollResultFor(entry) : { state: 'unknown' });
        stop();
        return;
      }
      const cancel = await takeEphemeral<{ userId: string }>(CANCEL_NAMESPACE, entry.connectId);
      if (cancel !== undefined && cancel.userId === entry.userId) {
        log.info('connect.cancelled_from_peer', { connectId: entry.connectId });
        await finish(entry);
        await publish(entry, { state: 'unknown', reason: 'cancelled' });
        stop();
        return;
      }
      await publish(entry, pollResultFor(entry));
    } catch (error) {
      log.warn('connect.mirror_tick_failed', {
        connectId: entry.connectId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), MIRROR_INTERVAL_MS);
  timer.unref();
  void tick();
  return stop;
}

/** Poll a connect session owned by another instance. */
export async function pollPeerConnect(
  userId: string,
  connectId: string
): Promise<ConnectPollResult> {
  const snapshot = await getEphemeral<ConnectSnapshot>(SNAPSHOT_NAMESPACE, connectId);
  if (snapshot === undefined || snapshot.userId !== userId) return { state: 'unknown' };
  return snapshot.result;
}

/** Ask the owning instance to abandon a connect session. */
export async function cancelPeerConnect(userId: string, connectId: string): Promise<void> {
  const snapshot = await getEphemeral<ConnectSnapshot>(SNAPSHOT_NAMESPACE, connectId);
  if (snapshot === undefined || snapshot.userId !== userId) return;
  await putEphemeral(CANCEL_NAMESPACE, connectId, { userId }, CANCEL_TTL_MS);
}
