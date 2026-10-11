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
 *     (multi-part: partStart - recordingStartMs + sum(prior durations in the
 *      same part) + video.currentTime, so a pause between parts stays aligned)
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
      // Keep the full title/body — the live-trajectory panel wraps rather than
      // truncating, so callers can read Cap/Wait/Probe/Search/Browser… in full.
      title: (m.metadata?.title as string | undefined) || (m.text ?? '') || '',
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

/**
 * Map a trajectory wall-clock offset back onto a (segment, timeInSegment) seek
 * target for a multi-segment playlist. Unknown/zero durations collapse to
 * segment 0 so a single-file recording still seeks correctly.
 */
export function seekTargetFromOffset(
  offsetSec: number,
  segmentDurationsSec: number[],
): { segmentIndex: number; timeInSegment: number } {
  const t = Number.isFinite(offsetSec) ? Math.max(0, offsetSec) : 0;
  if (segmentDurationsSec.length === 0) {
    return { segmentIndex: 0, timeInSegment: t };
  }
  let remaining = t;
  for (let i = 0; i < segmentDurationsSec.length; i++) {
    const d = segmentDurationsSec[i];
    const dur = Number.isFinite(d) && d > 0 ? d : 0;
    const isLast = i === segmentDurationsSec.length - 1;
    if (!isLast && dur > 0 && remaining > dur) {
      remaining -= dur;
      continue;
    }
    return { segmentIndex: i, timeInSegment: remaining };
  }
  return { segmentIndex: 0, timeInSegment: t };
}

/** A playlist segment placed in wall-clock time by its recording part. */
export type PartTimedSegment = { partIndex: number; partStartMs: number | null };

function partStartsKnown(
  segments: PartTimedSegment[],
  recordingStartMs: number | null,
): recordingStartMs is number {
  return (
    recordingStartMs !== null &&
    segments.length > 0 &&
    segments.every((segment) => segment.partStartMs !== null)
  );
}

/**
 * Playhead for a multi-part recording. Each part (one saved recording per
 * browser activity) starts at its own wall-clock start, so a pause between
 * parts — hours for an auth-assistance handoff — keeps later steps aligned.
 * Segments inside one part (Kernel per-session replays) follow each other.
 * Without every part start, falls back to one contiguous playlist.
 */
export function partPlayheadSec(
  segments: PartTimedSegment[],
  segmentDurationsSec: number[],
  segmentIndex: number,
  currentTimeSec: number,
  recordingStartMs: number | null,
): number {
  if (!partStartsKnown(segments, recordingStartMs) || !segments[segmentIndex]) {
    return playheadFromSegments(segmentDurationsSec, segmentIndex, currentTimeSec);
  }
  const segment = segments[segmentIndex];
  const partIndices = segments
    .map((other, index) => (other.partIndex === segment.partIndex ? index : -1))
    .filter((index) => index >= 0);
  const position = partIndices.indexOf(segmentIndex);
  const partStartSec = ((segment.partStartMs as number) - recordingStartMs) / 1000;
  return (
    partStartSec +
    playheadFromSegments(
      partIndices.map((index) => segmentDurationsSec[index] ?? 0),
      position,
      currentTimeSec,
    )
  );
}

/** Inverse of {@link partPlayheadSec}: the segment and in-segment time for a step offset. */
export function partSeekTarget(
  segments: PartTimedSegment[],
  segmentDurationsSec: number[],
  offsetSec: number,
  recordingStartMs: number | null,
): { segmentIndex: number; timeInSegment: number } {
  if (!partStartsKnown(segments, recordingStartMs)) {
    return seekTargetFromOffset(offsetSec, segmentDurationsSec);
  }
  // Segments are ordered by part start: take the last part starting at or
  // before the offset (or the first part when the offset precedes them all).
  let partIndex = segments[0].partIndex;
  let partStartSec = ((segments[0].partStartMs as number) - recordingStartMs) / 1000;
  for (const segment of segments) {
    const startSec = ((segment.partStartMs as number) - recordingStartMs) / 1000;
    if (startSec <= offsetSec + 1e-6) {
      partIndex = segment.partIndex;
      partStartSec = startSec;
    }
  }
  const partIndices = segments
    .map((segment, index) => (segment.partIndex === partIndex ? index : -1))
    .filter((index) => index >= 0);
  const local = seekTargetFromOffset(
    offsetSec - partStartSec,
    partIndices.map((index) => segmentDurationsSec[index] ?? 0),
  );
  return { segmentIndex: partIndices[local.segmentIndex], timeInSegment: local.timeInSegment };
}
