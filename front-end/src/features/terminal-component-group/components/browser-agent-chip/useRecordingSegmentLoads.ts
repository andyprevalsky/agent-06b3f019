/**
 * Lazy per-segment loading for the BrowserAgentChip recording playlist.
 *
 * STATE (per segment key):
 *   view  (Kernel replay URL):          [READY] (streamed by <video> directly)
 *   video/html (Supabase FilePointer): [IDLE] --selected while opened--> [LOADING]
 *                                        --ok--> [READY] (Blob URL) | --err--> [ERROR]
 *
 * SEGMENT LIST CHANGE (a later part arrives while open):
 *   keep the selected segment (by key) and every loaded part; revoke only Blob
 *   URLs whose segment left the list. Unmount revokes all; an in-flight load
 *   that lands after unmount/removal revokes its own Blob URL.
 */
import { useEffect, useRef, useState } from 'react';
import { getAttachmentUrl } from '@/lib/api/messages';
import type { RecordingSegment } from './recordingSegments';

type SegmentLoad =
  { state: 'loading' } | { state: 'ready'; url: string } | { state: 'error'; error: string };

export function useRecordingSegmentLoads(
  segments: RecordingSegment[],
  opened: boolean,
  agentId: string | null,
) {
  const [segmentLoads, setSegmentLoads] = useState<Record<string, SegmentLoad>>({});
  // The playing segment (activity part or Kernel session), by key, so a part
  // that arrives or sorts in front of it keeps playback where it is. Defaults
  // to (and falls back to) the earliest segment.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedIndex = segments.findIndex((segment) => segment.key === selectedKey);
  const segmentIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const currentSegment: RecordingSegment | undefined = segments[segmentIndex];
  const setSegmentIndex = (index: number) => setSelectedKey(segments[index]?.key ?? null);
  // Stable identity of the segment list (keys are URLs / storage paths).
  const recordingKey = segments.map((segment) => segment.key).join('\n');
  // Pin the default selection once the viewer opens the recording, so a part
  // that arrives later and sorts in front of it cannot take over playback.
  useEffect(() => {
    if (opened && selectedIndex < 0 && currentSegment) setSelectedKey(currentSegment.key);
  }, [opened, selectedIndex, currentSegment]);
  const liveKeysRef = useRef<Set<string>>(new Set());
  const blobUrlsRef = useRef<Map<string, string>>(new Map());
  const inFlightKeysRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const blobUrls = blobUrlsRef.current;
    return () => {
      // In-flight loads see this and revoke their own Blob URL on arrival.
      mountedRef.current = false;
      for (const blobUrl of blobUrls.values()) URL.revokeObjectURL(blobUrl);
      blobUrls.clear();
    };
  }, []);
  // A later part arriving while the chip is open keeps every loaded part; only
  // segments that disappeared are released.
  useEffect(() => {
    const keys = recordingKey ? recordingKey.split('\n') : [];
    const live = new Set(keys);
    liveKeysRef.current = live;
    for (const [key, blobUrl] of blobUrlsRef.current) {
      if (live.has(key)) continue;
      URL.revokeObjectURL(blobUrl);
      blobUrlsRef.current.delete(key);
    }
    setSegmentLoads((loads) =>
      Object.keys(loads).every((key) => live.has(key))
        ? loads
        : Object.fromEntries(Object.entries(loads).filter(([key]) => live.has(key))),
    );
  }, [recordingKey]);

  const currentLoad =
    currentSegment && currentSegment.kind !== 'view' ? segmentLoads[currentSegment.key] : undefined;
  useEffect(() => {
    if (!opened || !agentId || !currentSegment) return;
    if (currentSegment.kind === 'view' || currentLoad) return;
    const segment = currentSegment;
    if (inFlightKeysRef.current.has(segment.key)) return;
    inFlightKeysRef.current.add(segment.key);
    setSegmentLoads((loads) => ({ ...loads, [segment.key]: { state: 'loading' } }));
    const isCurrent = () => mountedRef.current && liveKeysRef.current.has(segment.key);
    void (async () => {
      try {
        const url = await getAttachmentUrl(
          agentId,
          segment.pointer.id,
          segment.pointer.storage_path,
        );
        // Supabase serves stored files as text/plain + nosniff (XSS safety), so a
        // direct <video>/<iframe> src won't play/render. Fetch the bytes and load
        // them via a typed Blob URL: video/mp4 for the stitched replay, text/html
        // for the screenshot player.
        const res = await fetch(url);
        if (!res.ok) throw new Error(`recording fetch ${res.status}`);
        const blob =
          segment.kind === 'video'
            ? new Blob([await res.arrayBuffer()], {
                type: segment.pointer.mime_type || 'video/mp4',
              })
            : new Blob([await res.text()], { type: 'text/html' });
        const blobUrl = URL.createObjectURL(blob);
        // The chip unmounted or the segment left the list while this load was in
        // flight — release the Blob URL instead of storing it.
        if (!isCurrent()) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        blobUrlsRef.current.set(segment.key, blobUrl);
        setSegmentLoads((loads) => ({ ...loads, [segment.key]: { state: 'ready', url: blobUrl } }));
      } catch (err) {
        if (!isCurrent()) return;
        const message = err instanceof Error ? err.message : '';
        // Ownership failures happen while signing the attachment URL. A later
        // 403 on the signed recording download is usually an expired URL, not
        // the wrong account — keep that as a generic load failure.
        const error = /Failed to get attachment URL.*\(403\)|Access denied/i.test(message)
          ? 'Sign in as the agent owner to load this recording.'
          : 'Failed to load recording.';
        setSegmentLoads((loads) => ({ ...loads, [segment.key]: { state: 'error', error } }));
      } finally {
        inFlightKeysRef.current.delete(segment.key);
      }
    })();
  }, [opened, agentId, currentSegment, currentLoad]);

  const recordingState: 'idle' | 'loading' | 'ready' | 'error' =
    currentSegment?.kind === 'view' ? 'ready' : (currentLoad?.state ?? 'idle');
  const recordingUrl =
    currentSegment?.kind === 'view'
      ? currentSegment.url
      : currentLoad?.state === 'ready'
        ? currentLoad.url
        : null;
  const recordingError = currentLoad?.state === 'error' ? currentLoad.error : null;

  return {
    segmentIndex,
    setSegmentIndex,
    currentSegment,
    recordingState,
    recordingUrl,
    recordingError,
  };
}
