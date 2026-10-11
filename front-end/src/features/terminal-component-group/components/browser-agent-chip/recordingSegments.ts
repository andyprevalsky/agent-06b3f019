/**
 * Every recording a browser task saved, as one chronological playlist.
 *
 * Diagram:
 *   task messages (time-ordered)
 *        │  one saved recording ("part") per browser activity: an approval or
 *        │  auth-assistance pause ends the activity, and the resumed activity
 *        │  records on a fresh recorder (often on a new session)
 *        ▼
 *   per saved message, its best source:
 *     video/* pointer     → [video]           (server-stitched MP4)
 *     recording_view_urls → [view, view, …]   (Kernel per-session replays)
 *     recording_view_url  → [view]
 *     other pointer       → [html]            (self-contained screenshot player)
 *   and its part start: metadata.recording_started_at, else (older rows) the
 *   latest still-unclaimed "recording started" message before it
 *        │
 *        ▼
 *   segments = parts ordered by start (save order can differ: a background
 *   finalizer may save the earlier part last), deduped
 *
 * Playing only the newest message's source hid every pre-pause step.
 */
import type { FilePointer } from '@/lib/api';

type SegmentSource =
  | { kind: 'view'; key: string; url: string }
  | { kind: 'video'; key: string; pointer: FilePointer }
  | { kind: 'html'; key: string; pointer: FilePointer };

export type RecordingSegment = SegmentSource & {
  label: string;
  /** Which saved recording (activity part) this segment belongs to. */
  partIndex: number;
  /** Wall-clock start of that part's recording, when known. */
  partStartMs: number | null;
};

type RecordingMessage = {
  timestamp?: string;
  metadata?: Record<string, unknown> | null;
};

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function messageSources(metadata: Record<string, unknown> | null | undefined): SegmentSource[] {
  const fp = metadata?.recording_file_pointer as FilePointer | null | undefined;
  if (fp?.storage_path && (fp.mime_type ?? '').startsWith('video/')) {
    return [{ kind: 'video', key: fp.storage_path, pointer: fp }];
  }
  const urls = metadata?.recording_view_urls;
  if (Array.isArray(urls)) {
    const clean = urls.filter((u): u is string => typeof u === 'string' && u.length > 0);
    if (clean.length) return clean.map((url) => ({ kind: 'view', key: url, url }));
  }
  const url = metadata?.recording_view_url;
  if (typeof url === 'string' && url.length > 0) return [{ kind: 'view', key: url, url }];
  if (fp?.storage_path) return [{ kind: 'html', key: fp.storage_path, pointer: fp }];
  return [];
}

/** Remove and return the unclaimed start nearest to `ms` (an explicit part start). */
function claimNearestStart(starts: number[], ms: number): void {
  let best = -1;
  starts.forEach((start, index) => {
    if (best < 0 || Math.abs(start - ms) < Math.abs(starts[best] - ms)) best = index;
  });
  if (best >= 0) starts.splice(best, 1);
}

export function buildRecordingSegments(messages: RecordingMessage[]): RecordingSegment[] {
  const seen = new Set<string>();
  const parts: { sources: SegmentSource[]; startMs: number | null; sortMs: number }[] = [];
  // "Browser recording started" times not yet matched to a saved part. Each
  // activity saves its recording after it starts, so an older row without
  // recording_started_at pairs with the latest unclaimed start (a stack keeps
  // that right even when the earlier part is saved last).
  const unclaimedStarts: number[] = [];
  messages.forEach((message, order) => {
    const metadata = message.metadata;
    if (metadata?.action_type === 'recording' && metadata?.toolStatus === 'IN_PROGRESS') {
      const startedMs = parseMs(message.timestamp);
      if (startedMs !== null) unclaimedStarts.push(startedMs);
    }
    const sources = messageSources(metadata).filter((source) => {
      if (seen.has(source.key)) return false;
      seen.add(source.key);
      return true;
    });
    if (!sources.length) return;
    const explicitStartMs = parseMs(metadata?.recording_started_at);
    if (explicitStartMs !== null) claimNearestStart(unclaimedStarts, explicitStartMs);
    const startMs = explicitStartMs ?? unclaimedStarts.pop() ?? null;
    parts.push({ sources, startMs, sortMs: startMs ?? parseMs(message.timestamp) ?? order });
  });
  parts.sort((a, b) => a.sortMs - b.sortMs);
  // One part's Kernel replays are its per-session (IP) segments; anything
  // spanning parts is a sequence of parts of the same task.
  const ipRotation = parts.length === 1 && parts[0].sources.length > 1;
  return parts
    .flatMap((part, partIndex) =>
      part.sources.map((source) => ({ ...source, partIndex, partStartMs: part.startMs })),
    )
    .map((segment, index) => ({
      ...segment,
      label: ipRotation ? (index === 0 ? 'baseline IP' : `rotation ${index}`) : `part ${index + 1}`,
    }));
}
