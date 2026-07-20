/**
 * STATE MACHINE: BrowserAgentChip
 *
 * Renders a browser-agent completion as a chip.
 *
 * EXPANSION:
 *   [COLLAPSED] --(click header)--> [EXPANDED] --(click header)--> [COLLAPSED]
 *     - COLLAPSED: shows only the final result summary (+ status dot, step count).
 *     - EXPANDED:  shows a 3-tab view.
 *
 * TAB (only meaningful while EXPANDED):
 *   [RESULT] <-> [TRAJECTORY] <-> [RECORDING]   (default RESULT)
 *
 * RECORDING URL (lazy, only when RECORDING tab first opened):
 *   recording_view_url (Kernel replay): [IDLE] --open--> [READY] (iframe URL directly)
 *   recording_file_pointer (Supabase):  [IDLE] --open--> [LOADING] --ok--> [READY]
 *                                                                  \--err-> [ERROR]
 *   (neither present => [UNAVAILABLE])
 *
 * Derives result/trajectory/recording from all messages sharing this message's
 * metadata.task_id (each browser step is its own message).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clapperboard, ListOrdered, FileText, Globe } from 'lucide-react';
import { getAttachmentUrl } from '@/lib/api/messages';
import { useAgentContext } from '../hooks';
import type { FilePointer, Message, OutputSchema } from '@/lib/api';
import { SchemaChip } from './SchemaChip';

type Tab = 'result' | 'trajectory' | 'recording';

interface BrowserAgentChipProps {
  message: Message;
}

function isFailure(text: string | undefined): boolean {
  return !!text && /❌|FAILED|\berror\b/i.test(text);
}

export default function BrowserAgentChip({ message }: BrowserAgentChipProps) {
  const { messages, selectedAgentId } = useAgentContext();
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<Tab>('result');
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingState, setRecordingState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  // Which Kernel replay segment (one per session/rotation) is currently playing.
  // The segments auto-advance into one continuous recording (baseline -> each
  // rotation), so this is the playhead, not a manual tab selection.
  const [segmentIndex, setSegmentIndex] = useState(0);

  const toolCallId = message.metadata?.toolCallId as string | undefined;

  // All messages for this browser tool call, time-ordered. The chip is anchored
  // on the outer tool-result message ("Browser automation complete/failed"),
  // which carries a toolCallId but no task_id. The inner per-session messages
  // (steps, recording, task_complete) carry the task_id; task_complete links the
  // two by sharing the toolCallId. So gather every task_id reachable from this
  // toolCallId (plus the anchor's own task_id, if any) and collect their messages.
  const taskMessages = useMemo(() => {
    const taskIds = new Set<string>();
    const ownTask = message.metadata?.task_id as string | undefined;
    if (ownTask) taskIds.add(ownTask);
    if (toolCallId) {
      for (const m of messages) {
        const tid = m.metadata?.task_id as string | undefined;
        if (tid && m.metadata?.toolCallId === toolCallId) taskIds.add(tid);
      }
    }
    if (taskIds.size === 0) return [message];
    return messages
      .filter((m) => {
        const tid = m.metadata?.task_id as string | undefined;
        return !!tid && taskIds.has(tid);
      })
      .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  }, [messages, toolCallId, message]);

  // Final result: the last substantive spawn_browser_agent status text for the task.
  const resultText = useMemo(() => {
    const statusMsg = [...taskMessages]
      .reverse()
      .find((m) => /\*\*Status\*\*|✅|❌|SUCCESS|FAILED/.test(m.text ?? ''));
    return statusMsg?.text || message.text || 'Browser task complete.';
  }, [taskMessages, message.text]);

  // Output schema + populated result values are keyed by this tool call. The
  // structured_response message carries no task_id, so look it up by toolCallId.
  const callMessages = useMemo(() => {
    if (!toolCallId) return [message];
    return messages.filter((m) => m.metadata?.toolCallId === toolCallId);
  }, [messages, toolCallId, message]);

  const outputSchema = useMemo<OutputSchema | undefined>(() => {
    for (const m of callMessages) {
      const os = m.metadata?.output_schema as OutputSchema | undefined;
      if (os?.fields?.length) return os;
    }
    return message.metadata?.output_schema as OutputSchema | undefined;
  }, [callMessages, message]);

  const structuredValues = useMemo<Record<string, unknown> | undefined>(() => {
    for (const m of callMessages) {
      const sr = m.metadata?.structured_response;
      if (sr && typeof sr === 'object') return sr as Record<string, unknown>;
    }
    return undefined;
  }, [callMessages]);

  // Prefer the LAST session's recording: a tool call may retry across several
  // browser sessions, and earlier ones are often the frozen/splash attempts —
  // the final session is the one that actually reached page content. A single
  // reverse scan returns whichever source the LATEST recording message carries
  // (Kernel view URL OR Supabase pointer) — scanning the two independently could
  // surface an older session's view URL over the latest retry's pointer.
  const recordingSource = useMemo<
    | { kind: 'video'; pointer: FilePointer }
    | { kind: 'view'; urls: string[] }
    | { kind: 'pointer'; pointer: FilePointer }
    | null
  >(() => {
    for (let i = taskMessages.length - 1; i >= 0; i--) {
      const md = taskMessages[i].metadata;
      const fp = md?.recording_file_pointer as FilePointer | null | undefined;
      // Preferred: rotate_ip's per-session replay segments stitched server-side into
      // ONE continuous MP4 (a video/* pointer). The FE plays it as a single video of
      // the exit IP changing across rotations — no playlist, no manual switching.
      if (fp?.storage_path && (fp.mime_type ?? '').startsWith('video/')) {
        return { kind: 'video', pointer: fp };
      }
      // Fallback (ffmpeg/stitch unavailable): the raw Kernel-hosted segment URLs,
      // played back-to-back. A single URL is just a one-segment list.
      const urls = md?.recording_view_urls as string[] | null | undefined;
      if (Array.isArray(urls)) {
        const clean = urls.filter((u): u is string => typeof u === 'string' && u.length > 0);
        if (clean.length) return { kind: 'view', urls: clean };
      }
      const url = md?.recording_view_url as string | null | undefined;
      if (url) return { kind: 'view', urls: [url] };
      // Legacy screenshot replay: a self-contained HTML player pointer.
      if (fp?.storage_path) return { kind: 'pointer', pointer: fp };
    }
    return null;
  }, [taskMessages]);

  const hasRecording = recordingSource !== null;
  // Stable identity of the selected recording; when a newer session's recording
  // arrives asynchronously, reset the loader so the chip re-resolves it instead
  // of pinning the stale URL/state.
  const recordingKey =
    recordingSource?.kind === 'view'
      ? recordingSource.urls.join('|')
      : (recordingSource?.pointer.storage_path ?? null);
  // Monotonic generation of the selected recording. Bumping it on every source
  // change invalidates any in-flight async load so a stale fetch can't overwrite
  // the newly selected recording (and leak its Blob URL).
  const recordingLoadGeneration = useRef(0);
  useEffect(() => {
    return () => {
      if (recordingUrl?.startsWith('blob:')) URL.revokeObjectURL(recordingUrl);
    };
  }, [recordingUrl]);
  useEffect(() => {
    recordingLoadGeneration.current += 1;
    setRecordingState('idle');
    setRecordingUrl(null);
    setSegmentIndex(0);
  }, [recordingKey]);

  const trajectory = useMemo(
    () =>
      taskMessages
        .map((m) => ({
          action: (m.metadata?.action_type as string) || m.metadata?.toolStatus || 'step',
          title: m.metadata?.title || (m.text ? m.text.slice(0, 80) : ''),
          status: m.metadata?.toolStatus as string | undefined,
          ts: m.timestamp,
        }))
        .filter((s) => s.action !== 'recording' && s.action !== 'network_recording'),
    [taskMessages],
  );

  const failed = isFailure(resultText);

  async function openRecording() {
    setTab('recording');
    if (recordingState !== 'idle' || !recordingSource) return;
    // Kernel replay: each segment's view URL streams that session's MP4 directly.
    // Multiple segments (one per rotation) auto-advance into one continuous video
    // (see the <video> playlist below) — no fetch, no manual tab switching.
    if (recordingSource.kind === 'view') {
      setSegmentIndex(0);
      setRecordingState('ready');
      return;
    }
    if (!selectedAgentId) return;
    const { pointer } = recordingSource;
    const isVideo = recordingSource.kind === 'video';
    const loadGeneration = recordingLoadGeneration.current;
    setRecordingState('loading');
    try {
      const url = await getAttachmentUrl(selectedAgentId, pointer.id, pointer.storage_path);
      // Supabase serves stored files as text/plain + nosniff (XSS safety), so a
      // direct <video>/<iframe> src won't play/render. Fetch the bytes and load them
      // via a typed Blob URL: video/mp4 for the stitched replay, text/html for the
      // legacy screenshot player.
      const res = await fetch(url);
      if (!res.ok) throw new Error(`recording fetch ${res.status}`);
      const blob = isVideo
        ? new Blob([await res.arrayBuffer()], { type: pointer.mime_type || 'video/mp4' })
        : new Blob([await res.text()], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);
      // A newer recording was selected while this load was in flight — discard
      // this result (and its Blob URL) instead of clobbering the current one.
      if (loadGeneration !== recordingLoadGeneration.current) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      setRecordingUrl(blobUrl);
      setRecordingState('ready');
    } catch {
      if (loadGeneration === recordingLoadGeneration.current) {
        setRecordingState('error');
      }
    }
  }

  return (
    <div
      data-testid="browser-agent-chip"
      className="my-1 w-full overflow-hidden rounded-lg border border-border bg-card text-sm"
    >
      {/* Header — toggles expansion. Collapsed shows only the result. */}
      <button
        type="button"
        data-testid="browser-agent-chip-header"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
      >
        <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${failed ? 'bg-red-500' : 'bg-emerald-500'}`}
        />
        <span className="truncate font-medium">Browser Agent</span>
        {/* Output schema + populated result values, on hover. */}
        <SchemaChip
          outputSchema={outputSchema}
          values={structuredValues}
          size="sm"
          tooltipPosition="bottom"
        />
        <span className="min-w-0 flex-1" />
        <span className="truncate text-muted-foreground">
          {failed ? 'Failed' : 'Done'} · {trajectory.length} steps
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {!expanded && (
        <div className="border-t border-border px-3 py-2 text-muted-foreground">
          <p className="line-clamp-2 whitespace-pre-wrap">{resultText}</p>
        </div>
      )}

      {expanded && (
        <div className="border-t border-border">
          {/* Tabs */}
          <div className="flex items-center gap-1 border-b border-border px-2 py-1">
            <TabButton active={tab === 'result'} onClick={() => setTab('result')} icon={FileText}>
              Result
            </TabButton>
            <TabButton
              active={tab === 'trajectory'}
              onClick={() => setTab('trajectory')}
              icon={ListOrdered}
            >
              Trajectory ({trajectory.length})
            </TabButton>
            <TabButton active={tab === 'recording'} onClick={openRecording} icon={Clapperboard}>
              Recording
            </TabButton>
          </div>

          <div className="p-3">
            {tab === 'result' && (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-xs">
                {resultText}
              </pre>
            )}

            {tab === 'trajectory' && (
              <ol className="max-h-80 space-y-1 overflow-auto text-xs">
                {trajectory.map((s, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="w-5 shrink-0 text-right text-muted-foreground">{i + 1}</span>
                    <span
                      className={`shrink-0 font-mono ${
                        s.status === 'ERROR' ? 'text-red-500' : 'text-muted-foreground'
                      }`}
                    >
                      {s.action}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  </li>
                ))}
              </ol>
            )}

            {tab === 'recording' && (
              <div>
                {!hasRecording && (
                  <p className="text-xs text-muted-foreground">
                    Recording unavailable for this run.
                  </p>
                )}
                {hasRecording && recordingState === 'loading' && (
                  <p className="text-xs text-muted-foreground">Loading recording…</p>
                )}
                {hasRecording && recordingState === 'error' && (
                  <p className="text-xs text-red-500">Failed to load recording.</p>
                )}
                {/* Stitched replay: rotate_ip's per-session segments were
                    concatenated server-side into ONE continuous MP4, so the whole
                    run (baseline -> each rotation, IP changing) plays in a single
                    video player. */}
                {hasRecording &&
                  recordingState === 'ready' &&
                  recordingSource?.kind === 'video' &&
                  recordingUrl && (
                    <video
                      title="Browser recording"
                      src={recordingUrl}
                      controls
                      autoPlay
                      muted
                      playsInline
                      className="aspect-[16/10] max-h-[75vh] w-full rounded border border-border bg-black"
                    />
                  )}
                {/* Fallback (stitch unavailable): play the raw per-rotation segment
                    URLs back-to-back. On each segment end we advance the playhead so
                    baseline -> rotation 1 -> ... still streams without manual
                    switching. A slim marker strip shows where each rotation begins. */}
                {hasRecording && recordingState === 'ready' && recordingSource?.kind === 'view' && (
                  <div>
                    {recordingSource.urls.length > 1 && (
                      <div data-testid="recording-segments" className="mb-2">
                        <p className="mb-1 text-xs text-muted-foreground">
                          Continuous replay — now showing{' '}
                          <span className="font-medium text-foreground">
                            {segmentIndex === 0 ? 'baseline IP' : `rotation ${segmentIndex}`}
                          </span>{' '}
                          ({segmentIndex + 1} of {recordingSource.urls.length} IPs)
                        </p>
                        <div className="flex h-1 w-full gap-0.5 overflow-hidden rounded">
                          {recordingSource.urls.map((url, i) => (
                            <div
                              key={url}
                              className={`h-full flex-1 rounded-full ${
                                i <= segmentIndex ? 'bg-foreground/70' : 'bg-muted'
                              }`}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    <video
                      key={recordingSource.urls[segmentIndex]}
                      title="Browser recording"
                      src={recordingSource.urls[segmentIndex]}
                      controls
                      autoPlay
                      muted
                      playsInline
                      onEnded={() => {
                        setSegmentIndex((i) => (i + 1 < recordingSource.urls.length ? i + 1 : i));
                      }}
                      className="aspect-[16/10] max-h-[75vh] w-full rounded border border-border bg-black"
                    />
                  </div>
                )}
                {hasRecording &&
                  recordingState === 'ready' &&
                  recordingSource?.kind === 'pointer' &&
                  recordingUrl && (
                    <iframe
                      title="Browser recording"
                      src={recordingUrl}
                      className="aspect-[16/10] max-h-[75vh] w-full rounded border border-border bg-black"
                    />
                  )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof FileText;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
        active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}
