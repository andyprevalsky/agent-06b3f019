/**
 * Thin, on-demand screen relay for attached phones.
 *
 *   UI  GET /:id/frame ──► markViewer(id) ──► wakes the Mac's long-poll
 *   Mac GET /:id/stream-demand?waitMs ◄─ { requested, maxFps, maxWidth }
 *   Mac PUT /:id/frame/upload (JPEG, <= maxFps) ──► latest frame per device
 *   UI  GET /:id/frame?after=<seq> ──► newer frame bytes | 204
 *
 * Bandwidth is bounded at the source: the Mac captures only while a viewer
 * polled within STREAM_DEMAND_TTL_MS, at most STREAM_MAX_FPS frames/s and
 * STREAM_MAX_WIDTH px wide. Only the newest frame per device is kept, for at
 * most FRAME_CACHE_MAX_DEVICES devices, so memory is O(watched phones), never
 * O(agents). State is per backend process: with several instances a viewer
 * and its Mac must reach the same one (see the lane report's gap list).
 */
import {
  FRAME_CACHE_MAX_DEVICES,
  FRAME_TTL_MS,
  STREAM_DEMAND_TTL_MS,
  STREAM_JPEG_QUALITY,
  STREAM_MAX_FPS,
  STREAM_MAX_WIDTH,
} from './config';
import type { PhoneStreamDemand } from './types';

export interface RelayedFrame {
  bytes: Buffer;
  contentType: string;
  seq: number;
  capturedAt: number;
  width: number;
  height: number;
}

const frames = new Map<string, RelayedFrame>();
const viewerSeenAt = new Map<string, number>();
const demandWaiters = new Map<string, Set<() => void>>();
const lastSeq = new Map<string, number>();

function pruneViewers(now: number): void {
  if (viewerSeenAt.size <= FRAME_CACHE_MAX_DEVICES) return;
  for (const [id, at] of viewerSeenAt) {
    if (now - at > STREAM_DEMAND_TTL_MS) viewerSeenAt.delete(id);
  }
}

export function streamDemand(phoneId: string, now = Date.now()): PhoneStreamDemand {
  const seen = viewerSeenAt.get(phoneId);
  return {
    requested: seen !== undefined && now - seen <= STREAM_DEMAND_TTL_MS,
    maxFps: STREAM_MAX_FPS,
    maxWidth: STREAM_MAX_WIDTH,
    jpegQuality: STREAM_JPEG_QUALITY,
  };
}

/** A viewer is watching: keep (or start) the Mac streaming. */
export function markViewer(phoneId: string, now = Date.now()): void {
  viewerSeenAt.set(phoneId, now);
  pruneViewers(now);
  const waiters = demandWaiters.get(phoneId);
  if (!waiters) return;
  demandWaiters.delete(phoneId);
  for (const wake of waiters) wake();
}

/**
 * Resolve as soon as a viewer appears, or after `waitMs` with the current
 * demand. `onAbort` lets the route stop waiting when the Mac disconnects.
 */
export function waitForStreamDemand(
  phoneId: string,
  waitMs: number,
  onAbort: (cancel: () => void) => void
): Promise<PhoneStreamDemand> {
  const current = streamDemand(phoneId);
  if (current.requested || waitMs <= 0) return Promise.resolve(current);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      demandWaiters.get(phoneId)?.delete(finish);
      if (demandWaiters.get(phoneId)?.size === 0) demandWaiters.delete(phoneId);
      resolve(streamDemand(phoneId));
    };
    const timer = setTimeout(finish, waitMs);
    const set = demandWaiters.get(phoneId) ?? new Set<() => void>();
    set.add(finish);
    demandWaiters.set(phoneId, set);
    onAbort(finish);
  });
}

function evictOldestFrame(): void {
  let oldestId: string | null = null;
  let oldestAt = Infinity;
  for (const [id, frame] of frames) {
    if (frame.capturedAt < oldestAt) {
      oldestAt = frame.capturedAt;
      oldestId = id;
    }
  }
  if (oldestId !== null) frames.delete(oldestId);
}

export function storeFrame(
  phoneId: string,
  frame: Omit<RelayedFrame, 'seq' | 'capturedAt'>,
  now = Date.now()
): RelayedFrame {
  // Millisecond-based and strictly increasing per phone, so a viewer's
  // `after` cursor stays valid even after this phone's entry was pruned.
  const seq = Math.max(now, (lastSeq.get(phoneId) ?? 0) + 1);
  lastSeq.set(phoneId, seq);
  if (!frames.has(phoneId) && frames.size >= FRAME_CACHE_MAX_DEVICES) evictOldestFrame();
  if (lastSeq.size > FRAME_CACHE_MAX_DEVICES * 4) {
    for (const id of lastSeq.keys()) if (!frames.has(id) && id !== phoneId) lastSeq.delete(id);
  }
  const stored: RelayedFrame = { ...frame, seq, capturedAt: now };
  frames.set(phoneId, stored);
  return stored;
}

/** The newest fresh frame, or null (none, stale, or not newer than `after`). */
export function latestFrame(
  phoneId: string,
  after?: number,
  now = Date.now()
): RelayedFrame | null {
  const frame = frames.get(phoneId);
  if (!frame) return null;
  if (now - frame.capturedAt > FRAME_TTL_MS) {
    frames.delete(phoneId);
    return null;
  }
  if (after !== undefined && frame.seq <= after) return null;
  return frame;
}

/** Drop relay state for a phone (forgotten device). */
export function clearRelay(phoneId: string): void {
  frames.delete(phoneId);
  viewerSeenAt.delete(phoneId);
  lastSeq.delete(phoneId);
}
