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
import { useEffect, useMemo, useState } from 'react';
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
    { kind: 'view'; url: string } | { kind: 'pointer'; pointer: FilePointer } | null
  >(() => {
    for (let i = taskMessages.length - 1; i >= 0; i--) {
      const md = taskMessages[i].metadata;
      const url = md?.recording_view_url as string | null | undefined;
      if (url) return { kind: 'view', url };
      const fp = md?.recording_file_pointer as FilePointer | null | undefined;
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
      ? recordingSource.url
      : (recordingSource?.pointer.storage_path ?? null);
  useEffect(() => {
    setRecordingState('idle');
    setRecordingUrl(null);
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
    // Kernel replay: the view URL is a ready-to-iframe hosted player — no fetch.
    if (recordingSource.kind === 'view') {
      setRecordingUrl(recordingSource.url);
      setRecordingState('ready');
      return;
    }
    if (!selectedAgentId) return;
    const { pointer } = recordingSource;
    setRecordingState('loading');
    try {
      const url = await getAttachmentUrl(selectedAgentId, pointer.id, pointer.storage_path);
      // Supabase serves stored files as text/plain + nosniff (XSS safety), so an
      // <iframe src> would show raw HTML. Fetch the bytes and load them via a
      // text/html Blob URL so the recording actually renders.
      const res = await fetch(url);
      if (!res.ok) throw new Error(`recording fetch ${res.status}`);
      const html = await res.text();
      const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      setRecordingUrl(blobUrl);
      setRecordingState('ready');
    } catch {
      setRecordingState('error');
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
                {hasRecording && recordingState === 'ready' && recordingUrl && (
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
