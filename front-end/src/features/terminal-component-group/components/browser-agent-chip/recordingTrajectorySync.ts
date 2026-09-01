/**
 * Map browser-recording playhead time → the trajectory step that was current
 * at that wall-clock moment.
 *
 * Diagram:
 *   recordingStartMs (first `recording` / `network_recording` message)
 *        │
 *        ▼
 *   step.offsetSec = (step.tsMs - recordingStartMs) / 1000
 *        │
 *   playheadSec = sum(priorSegmentDurations) + video.currentTime
 *        │
 *        ▼
 *   activeIndex = last i where offsetSec[i] <= playheadSec
 */

export type TrajectoryStep = {
  action: string;
  title: string;
  status?: string;
  ts?: string;
  /** Seconds relative to recording start. Negative = before the recorder started. */
  offsetSec: number;
};

type TimedMessage = {
  timestamp?: string;
  text?: string;
  metadata?: Record<string, unknown> | null;
};

function parseTsMs(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function isRecordingAction(action: unknown): boolean {
  return action === 'recording' || action === 'network_recording';
}

/** Wall-clock t0 for the replay: earliest recording / network_recording message. */
export function recordingStartMsFromMessages(messages: TimedMessage[]): number | null {
  let earliest: number | null = null;
  for (const m of messages) {
    if (!isRecordingAction(m.metadata?.action_type)) continue;
    const ms = parseTsMs(m.timestamp);
    if (ms === null) continue;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}

/**
 * Resolve t0 for scrub sync. Prefer the recorder's own start message; fall back
 * to the earliest trajectory step so scrub still maps when the recording
 * status row is missing.
 */
export function resolveRecordingStartMs(messages: TimedMessage[]): number | null {
  const fromRec = recordingStartMsFromMessages(messages);
  if (fromRec !== null) return fromRec;
  let earliest: number | null = null;
  for (const m of messages) {
    if (isRecordingAction(m.metadata?.action_type)) continue;
    const ms = parseTsMs(m.timestamp);
    if (ms === null) continue;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}

export function buildTrajectorySteps(
  messages: TimedMessage[],
  recordingStartMs: number | null,
): TrajectoryStep[] {
  const steps: TrajectoryStep[] = [];
  for (const m of messages) {
    const action =
      (m.metadata?.action_type as string | undefined) ||
      (m.metadata?.toolStatus as string | undefined) ||
      'step';
    if (isRecordingAction(action)) continue;
    const ts = m.timestamp;
    const tsMs = parseTsMs(ts);
    const offsetSec =
      recordingStartMs !== null && tsMs !== null ? (tsMs - recordingStartMs) / 1000 : 0;
    steps.push({
      action,
      title:
        (m.metadata?.title as string | undefined) || (m.text ? m.text.slice(0, 80) : '') || '',
      status: m.metadata?.toolStatus as string | undefined,
      ts,
      offsetSec,
    });
  }
  return steps;
}

/**
 * Last step whose offset is at or before the playhead. Returns -1 when the
 * playhead is still before every step (or the list is empty).
 */
export function findActiveStepIndex(steps: TrajectoryStep[], playheadSec: number): number {
  if (steps.length === 0) return -1;
  let active = -1;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].offsetSec <= playheadSec + 1e-6) active = i;
  }
  return active;
}

/** Cumulative playhead across a multi-segment playlist. */
export function playheadFromSegments(
  priorSegmentDurationsSec: number[],
  segmentIndex: number,
  currentTimeSec: number,
): number {
  let prior = 0;
  const limit = Math.min(segmentIndex, priorSegmentDurationsSec.length);
  for (let i = 0; i < limit; i++) {
    const d = priorSegmentDurationsSec[i];
    if (Number.isFinite(d) && d > 0) prior += d;
  }
  return prior + (Number.isFinite(currentTimeSec) ? Math.max(0, currentTimeSec) : 0);
}
