/**
 * STATE MACHINE: BrowserAgentChip
 *
 * Renders a browser-agent completion as a chip.
 *
 * EXPANSION:
 *   [COLLAPSED] --(click header)--> [EXPANDED] --(click header)--> [COLLAPSED]
 *     - COLLAPSED: shows only the final result summary as plain text, markdown
 *       markup stripped (+ status dot, step count).
 *     - EXPANDED: result includes this tool call’s output files; recording stays separate.
 *
 * STATUS (derived from the result text, which leads with the task goal):
 *   **Status** line present => [FAILED] iff that line has ❌/FAILED, else [DONE]
 *   no **Status** line      => [FAILED] iff the text has ❌/FAILED/error, else [DONE]
 *
 * TAB (only meaningful while EXPANDED):
 *   [RESULT] <-> [RECORDING]   (default RESULT)
 *   RECORDING = video player + live trajectory side panel (scrub-synced)
 *
 * RECORDING SEGMENTS (buildRecordingSegments): every recording the task saved,
 * earliest first. An approval/auth-assistance pause splits one task into
 * several activities, each with its own saved recording; one activity's Kernel
 * per-session replays expand in place. (none => [UNAVAILABLE])
 *   [SEGMENT 0] --video ended | click part i--> [SEGMENT i]
 *
 * SEGMENT LOAD (lazy, while the RECORDING tab is visible; ready parts cached):
 *   view (Kernel replay URL):          [READY] (streamed by <video> directly)
 *   video/html (Supabase FilePointer): [IDLE] --select--> [LOADING] --ok--> [READY]
 *                                                                   \--err-> [ERROR]
 *   READY Blob URLs are cached per segment and revoked on unmount/segment reset.
 *
 * RECORDING PLAYHEAD ↔ LIVE TRAJECTORY (while RECORDING tab READY + <video>):
 *   video.timeupdate|seeked
 *        │
 *        ▼
 *   playheadSec = partStart + sum(prior durations in the part) + currentTime
 *        │
 *        ▼
 *   activeStep = last traj step with offsetSec <= playheadSec
 *        │
 *        ▼
 *   side panel highlight + scrollIntoView
 *   (fixed portal hanging off the recording — no layout/scroll shift,
 *    z-index above terminal chrome so it stays visible)
 *
 * LIVE TRAJECTORY CLICK → VIDEO SEEK:
 *   click step i
 *        │
 *        ▼
 *   (segmentIndex, timeInSegment) = partSeekTarget(step.offsetSec, …)
 *        │   (each part placed at its own start; a pause keeps steps aligned)
 *        ▼
 *   same segment:  video.currentTime = timeInSegment (+ play)
 *   other segment: pending seek → setSegmentIndex → applied on its video's
 *                  loadedmetadata (after the segment loads, if it must)
 *
 * Derives result/trajectory/recording from all messages sharing this message's
 * metadata.task_id (each browser step is its own message).
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useToolArtifacts } from './toolArtifactContext';
import { AttachmentDisplay } from './message-bubble/AttachmentDisplay';
import { useMediaElementResource } from '@/hooks/useMediaElementResource';
import { ChevronDown, Clapperboard, FileText, Globe } from 'lucide-react';
import { useAgentContext } from '../hooks';
import type { Message, OutputSchema } from '@/lib/api';
import { SchemaChip } from './SchemaChip';
import { markdownPreview } from './browser-agent-chip/resultPreview';
import {
  buildTrajectorySteps,
  findActiveStepIndex,
  partPlayheadSec,
  partSeekTarget,
  resolveRecordingStartMs,
  type TrajectoryStep,
} from './browser-agent-chip/recordingTrajectorySync';
import {
  buildRecordingSegments,
  type RecordingSegment,
} from './browser-agent-chip/recordingSegments';
import { RecordingSegmentStrip } from './browser-agent-chip/RecordingSegmentStrip';
import { isFailedBrowserResult } from './browser-agent-chip/resultStatus';
import { useRecordingSegmentLoads } from './browser-agent-chip/useRecordingSegmentLoads';
import { LiveViewFrame } from './browser-status-bar/BrowserLiveViewFrame';

type Tab = 'result' | 'recording';

interface BrowserAgentChipProps {
  message: Message;
}

export default function BrowserAgentChip({ message }: BrowserAgentChipProps) {
  const artifacts = useToolArtifacts();
  const { messages, selectedAgentId } = useAgentContext();
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<Tab>('result');
  // Wall-clock-aligned playhead (seconds from recording start). Driven by the
  // video element so scrubbing / playback updates the live trajectory side panel.
  const [playheadSec, setPlayheadSec] = useState(0);
  // Known <video> durations by segment key (they survive appended parts).
  const segmentDurationsRef = useRef<Map<string, number>>(new Map());
  // Shared across stitched + multi-URL players so trajectory clicks can seek.
  const { mediaRef: videoRef, setMediaRef: setVideoRef } =
    useMediaElementResource<HTMLVideoElement>();
  // A trajectory click into another segment seeks once that segment's video loads.
  const pendingSeekRef = useRef<{ key: string; timeSec: number } | null>(null);

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

  // Every recording the task saved, ordered by part start: a pause/resume
  // splits one task into several activities, and each saves its own recording.
  const recordingSegments = useMemo<RecordingSegment[]>(
    () =>
      buildRecordingSegments(
        taskMessages.map((m) => ({
          timestamp: m.timestamp,
          metadata: (m.metadata as Record<string, unknown> | undefined) ?? null,
        })),
      ),
    [taskMessages],
  );
  const hasRecording = recordingSegments.length > 0;
  const {
    segmentIndex,
    setSegmentIndex,
    currentSegment,
    recordingState,
    recordingUrl,
    recordingError,
  } = useRecordingSegmentLoads(recordingSegments, expanded && tab === 'recording', selectedAgentId);

  const recordingStartMs = useMemo(
    () =>
      resolveRecordingStartMs(
        taskMessages.map((m) => ({
          timestamp: m.timestamp,
          text: m.text,
          metadata: (m.metadata as Record<string, unknown> | undefined) ?? null,
        })),
      ),
    [taskMessages],
  );

  const trajectory = useMemo(
    () =>
      buildTrajectorySteps(
        taskMessages.map((m) => ({
          timestamp: m.timestamp,
          text: m.text,
          metadata: (m.metadata as Record<string, unknown> | undefined) ?? null,
        })),
        recordingStartMs,
      ),
    [taskMessages, recordingStartMs],
  );

  const activeStepIndex = useMemo(
    () => findActiveStepIndex(trajectory, playheadSec),
    [trajectory, playheadSec],
  );

  const failed = isFailedBrowserResult(resultText);

  function segmentDurations(): number[] {
    return recordingSegments.map((segment) => segmentDurationsRef.current.get(segment.key) ?? 0);
  }

  function syncPlayheadFromVideo(video: HTMLVideoElement, segIdx: number) {
    const key = recordingSegments[segIdx]?.key;
    if (key && Number.isFinite(video.duration) && video.duration > 0) {
      segmentDurationsRef.current.set(key, video.duration);
    }
    setPlayheadSec(
      partPlayheadSec(
        recordingSegments,
        segmentDurations(),
        segIdx,
        video.currentTime,
        recordingStartMs,
      ),
    );
  }

  function handleVideoTimeSync(event: SyntheticEvent<HTMLVideoElement>) {
    syncPlayheadFromVideo(event.currentTarget, segmentIndex);
  }

  function seekVideo(video: HTMLVideoElement, timeSec: number) {
    video.currentTime = timeSec;
    void video.play().catch(() => {});
    syncPlayheadFromVideo(video, segmentIndex);
  }

  function handleVideoLoadedMetadata(event: SyntheticEvent<HTMLVideoElement>) {
    const pending = pendingSeekRef.current;
    if (pending && pending.key === currentSegment?.key) {
      pendingSeekRef.current = null;
      seekVideo(event.currentTarget, pending.timeSec);
      return;
    }
    handleVideoTimeSync(event);
  }

  /** Click a trajectory row → jump the recording to that step's wall-clock time. */
  function seekRecordingToOffset(offsetSec: number) {
    const { segmentIndex: nextSeg, timeInSegment } = partSeekTarget(
      recordingSegments,
      segmentDurations(),
      offsetSec,
      recordingStartMs,
    );
    const target = recordingSegments[nextSeg];
    if (!target) return;
    if (nextSeg !== segmentIndex) {
      // The target segment's <video> mounts (and may load first) after the
      // switch; its loadedmetadata applies the seek.
      pendingSeekRef.current =
        target.kind === 'html' ? null : { key: target.key, timeSec: timeInSegment };
      setSegmentIndex(nextSeg);
      return;
    }
    if (videoRef.current) seekVideo(videoRef.current, timeInSegment);
  }

  function openRecording() {
    setTab('recording');
  }

  function selectSegment(index: number) {
    pendingSeekRef.current = null;
    setSegmentIndex(index);
    setPlayheadSec(
      partPlayheadSec(recordingSegments, segmentDurations(), index, 0, recordingStartMs),
    );
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
          <p className="line-clamp-2 whitespace-pre-wrap">{markdownPreview(resultText)}</p>
        </div>
      )}

      {expanded && (
        <div className="border-t border-border">
          {/* Tabs */}
          <div className="flex items-center gap-1 border-b border-border px-2 py-1">
            <TabButton active={tab === 'result'} onClick={() => setTab('result')} icon={FileText}>
              Result
            </TabButton>
            <TabButton active={tab === 'recording'} onClick={openRecording} icon={Clapperboard}>
              Recording ({trajectory.length})
            </TabButton>
          </div>

          <div className="p-3">
            {tab === 'result' && (
              <div>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-xs">
                  {resultText}
                </pre>
                <AttachmentDisplay
                  attachments={artifacts.flatMap((row) =>
                    row.file_pointer ? [row.file_pointer] : [],
                  )}
                  agentId={selectedAgentId || undefined}
                />
              </div>
            )}

            {tab === 'recording' && (
              <div>
                {!hasRecording && (
                  <p className="text-xs text-muted-foreground">
                    Recording unavailable for this run.
                  </p>
                )}
                {recordingSegments.length > 1 && (
                  <RecordingSegmentStrip
                    segments={recordingSegments}
                    activeIndex={segmentIndex}
                    onSelect={selectSegment}
                  />
                )}
                {hasRecording && recordingState === 'loading' && (
                  <p className="text-xs text-muted-foreground">Loading recording…</p>
                )}
                {hasRecording && recordingState === 'error' && (
                  <p className="text-xs text-red-500">
                    {recordingError ?? 'Failed to load recording.'}
                  </p>
                )}
                {/* Video segments (a Kernel replay URL or the server-stitched MP4)
                    play in one <video> that advances to the next segment when it
                    ends, so baseline -> each rotation -> each later part streams
                    without manual switching. Live trajectory sits beside the video
                    and tracks the playhead as the user scrubs. */}
                {recordingState === 'ready' && currentSegment?.kind !== 'html' && recordingUrl && (
                  <RecordingWithLiveTrajectory
                    steps={trajectory}
                    activeIndex={activeStepIndex}
                    playheadSec={playheadSec}
                    onStepClick={seekRecordingToOffset}
                  >
                    <video
                      ref={setVideoRef}
                      key={recordingUrl}
                      title="Browser recording"
                      src={recordingUrl}
                      controls
                      autoPlay
                      muted
                      playsInline
                      onTimeUpdate={handleVideoTimeSync}
                      onSeeked={handleVideoTimeSync}
                      onLoadedMetadata={handleVideoLoadedMetadata}
                      onEnded={() => {
                        if (segmentIndex + 1 < recordingSegments.length) {
                          selectSegment(segmentIndex + 1);
                        }
                      }}
                      className="aspect-[16/10] max-h-[75vh] w-full overflow-hidden rounded border border-border bg-black object-contain"
                    />
                  </RecordingWithLiveTrajectory>
                )}
                {/* Screenshot replay: a self-contained HTML player per part. */}
                {recordingState === 'ready' && currentSegment?.kind === 'html' && recordingUrl && (
                  <div className="relative aspect-[1280/800] max-h-[75vh] w-full overflow-hidden rounded border border-border bg-black">
                    <LiveViewFrame
                      url={recordingUrl}
                      title="Browser recording"
                      className="absolute inset-0"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RecordingWithLiveTrajectory({
  steps,
  activeIndex,
  playheadSec,
  onStepClick,
  children,
}: {
  steps: TrajectoryStep[];
  activeIndex: number;
  playheadSec: number;
  onStepClick?: (offsetSec: number) => void;
  children: React.ReactNode;
}) {
  // Fixed portal anchored to the recording box — zero layout/scroll impact on the
  // conversation, and z-index above terminal chrome so it is never clipped/hidden.
  const anchorRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    // Wider than w-72 so long action names (browser_challenge_recovery) leave
    // room for wrapped titles instead of Cap…/Wai…/Bro… ellipsis.
    const PANEL_W = 340;
    const GAP = 8;

    const sync = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Always hang OUTSIDE the recording (never overlay it). Fixed positioning
      // means this cannot shift conversation layout or scroll width; if the
      // viewport is tight the panel may clip off-screen rather than cover video.
      const left = r.right + GAP;
      setPanelStyle({
        position: 'fixed',
        top: Math.max(GAP, r.top),
        left,
        height: Math.max(120, Math.min(r.height, window.innerHeight - Math.max(GAP, r.top) - GAP)),
        width: PANEL_W,
        zIndex: 9999,
      });
    };

    sync();
    const ro = new ResizeObserver(sync);
    if (anchorRef.current) ro.observe(anchorRef.current);
    window.addEventListener('resize', sync);
    // Capture scroll from any nested terminal scroller.
    window.addEventListener('scroll', sync, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
    };
  }, []);

  return (
    <div ref={anchorRef} data-testid="recording-with-live-trajectory" className="relative w-full">
      {children}
      {panelStyle &&
        createPortal(
          <aside
            data-testid="recording-live-trajectory-panel"
            style={panelStyle}
            className="flex flex-col"
            aria-label="Live trajectory"
          >
            <div className="flex h-full min-h-0 flex-col rounded-md border border-border bg-card p-2">
              <div className="mb-1 flex shrink-0 items-baseline justify-between gap-2">
                <p className="text-xs font-medium text-foreground">Live trajectory</p>
                <p
                  data-testid="recording-playhead"
                  className="font-mono text-[10px] text-muted-foreground"
                >
                  t={playheadSec.toFixed(1)}s
                </p>
              </div>
              <TrajectoryList
                steps={steps}
                activeIndex={activeIndex}
                live
                onStepClick={onStepClick}
              />
            </div>
          </aside>,
          document.body,
        )}
    </div>
  );
}

function TrajectoryList({
  steps,
  activeIndex,
  live = false,
  onStepClick,
}: {
  steps: TrajectoryStep[];
  activeIndex: number;
  live?: boolean;
  onStepClick?: (offsetSec: number) => void;
}) {
  const activeRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!live || activeIndex < 0) return;
    // jsdom does not implement scrollIntoView; guard so scrub-sync tests can run.
    activeRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [live, activeIndex]);

  return (
    <ol
      data-testid={live ? 'recording-live-trajectory' : 'trajectory-list'}
      className={`${live ? 'min-h-0 flex-1' : 'max-h-80'} space-y-1 overflow-auto text-xs`}
    >
      {steps.map((s, i) => {
        const isActive = i === activeIndex;
        const isPast = activeIndex >= 0 && i < activeIndex;
        const clickable = typeof onStepClick === 'function';
        return (
          <li
            key={i}
            ref={isActive ? activeRef : undefined}
            data-testid={isActive ? 'recording-active-step' : undefined}
            data-step-index={i}
            data-step-offset={s.offsetSec}
          >
            <button
              type="button"
              disabled={!clickable}
              onClick={() => onStepClick?.(s.offsetSec)}
              title={clickable ? `Seek recording to t=${s.offsetSec.toFixed(1)}s` : s.title}
              className={`flex w-full flex-col items-stretch gap-0.5 rounded px-1.5 py-1 text-left ${
                clickable ? 'cursor-pointer hover:bg-foreground/5' : 'cursor-default'
              } ${
                isActive
                  ? 'bg-foreground/10 ring-1 ring-foreground/20'
                  : isPast
                    ? 'opacity-70'
                    : live
                      ? 'opacity-40'
                      : ''
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="w-5 shrink-0 text-right text-muted-foreground">{i + 1}</span>
                <span
                  className={`min-w-0 flex-1 break-words font-mono ${
                    s.status === 'ERROR' ? 'text-red-500' : 'text-muted-foreground'
                  }`}
                >
                  {s.action}
                </span>
              </div>
              {s.title ? (
                <p className="break-words whitespace-normal pl-7 text-[11px] leading-snug text-foreground/80">
                  {s.title}
                </p>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
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
