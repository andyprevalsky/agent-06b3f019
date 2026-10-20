/**
 * STATE MACHINE: DesktopCodeAgentChip (Rose Desktop flag on AND metadata.code_agent present)
 *
 * LIFECYCLE (code_agent.state; a terminal task_complete message wins):
 *   [spinning_up] → header only (spinner · target)
 *   [live]        → header (pulsing dot · Active · running timer · target) + body
 *   [completed]   → header (check · Completed Successfully · duration · target) + summary
 *   [failed]      → header (✕ · Failed · duration · target) + red failure box (always shown)
 *                   with the backend's failure text verbatim (LOCAL_TARGET_UNAVAILABLE etc.)
 *   [paused]      → header (muted pause · Paused · duration · target), never red: the
 *                   session is saved and resumable. A usage-limit stop (C15) reads
 *                   "Paused - usage limit, resumes on <other CLI>"; no Retry button
 *                   (the backend has no user-callable retry route yet).
 *
 * TARGET (code_agent.target): 'local' → "This Mac · <folder>" (device_name tooltip),
 *   else "Cloud". Mac app only (window.api.localCode) + local + running →
 *   "Open in Terminal" → window.api.localCode.openTerminal(taskId); hidden on web.
 *
 * BODY: [OPEN] (default) ⇄ [CLOSED] via header click
 *   live:      TAB [TRANSCRIPT] (default) ⇄ [TERMINAL] (existing xterm, kept mounted)
 *              + "Message <agent> directly…" steer input
 *   completed: commit · branch · merged into · tests · files ± · Open preview
 *              (no summary → read-only transcript when events exist)
 *   failed / paused: read-only transcript when events exist
 *   not running + code_session: "<branch> → <merge_target> · pushed · PR #n · merged"
 *
 * PREVIEW CARD (code_agent.preview_url, dev cloud sessions; rows 10/39): a small
 *   live preview under the header, framed only while on screen; clicking it opens
 *   the full-screen app view for this task (CodeAgentPreviewCard).
 *
 * Maximize opens the existing FullscreenView (owned by ClaudeCodeChip).
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Maximize2 } from 'lucide-react';

import {
  codeAgentLabel,
  codeAgentTargetLabel,
  eventTimeMs,
  usageLimitPausedText,
  type CodeAgentMeta,
  type CodeAgentSummary,
  type CodeAgentTranscriptEvent,
  type CodeSessionFacts,
} from '../hooks/codeAgentContract';
import { useLocalEchoes } from '../hooks/codeAgentLocalState';
import { desktopChipState, formatElapsed, useNow } from '../hooks/codeAgentSteering';
import { ProviderIcon, StatusDisplay, TerminalSurface } from './claudeCodeChip.shared';
import type { ClaudeCodeChipVM } from './claudeCodeChip.hooks';
import {
  ChipTabs,
  CodeAgentSteerInput,
  CodeAgentTranscript,
  type ChipTab,
} from './codeAgentChip.steer';
import { CodeAgentPreviewCard } from './app-view/CodeAgentPreviewCard';

const MUTED = 'text-muted-foreground dark:text-[#a3a39d]';
const CODE = 'font-mono text-[12.5px] text-[#e8507f]';

function Summary({ summary }: { summary: CodeAgentSummary }) {
  const tests =
    summary.tests_passed === undefined
      ? null
      : summary.tests_total === undefined
        ? `tests ${summary.tests_passed} passed`
        : `tests ${summary.tests_passed}/${summary.tests_total} passed`;
  return (
    <div
      data-testid="code-agent-summary"
      className="border-t border-border pb-3 pl-11 pr-3.5 pt-2.5 text-[13px] text-foreground/80 dark:border-white/[.09] dark:text-[#ecece8]"
    >
      <div>
        Committed <code className={CODE}>{summary.commit.slice(0, 7)}</code> on{' '}
        <code className={CODE}>{summary.branch}</code>
        {summary.merged_into && (
          <>
            {' '}
            · merged into <code className={CODE}>{summary.merged_into}</code>
          </>
        )}
        {tests && <> · {tests}</>}
      </div>
      {summary.files.length > 0 && (
        <div className="mb-1.5 mt-2">
          {summary.files.map((file) => (
            <div
              key={file.path}
              data-testid="code-agent-file"
              className="flex gap-2.5 py-0.5 font-mono text-[12.5px]"
            >
              <span className="text-green-600 dark:text-green-400">+{file.added}</span>
              <span className="text-red-600 dark:text-red-400">−{file.removed}</span>
              <span className="min-w-0 truncate">{file.path}</span>
            </div>
          ))}
        </div>
      )}
      {summary.preview_url && (
        <a
          href={summary.preview_url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-[#e8507f] no-underline hover:underline"
        >
          Open preview
        </a>
      )}
    </div>
  );
}

/** The persistent code session's branch and where it merges, with push / PR / merge facts. */
function SessionLine({ session, meta }: { session: CodeSessionFacts; meta: CodeAgentMeta }) {
  const branch = session.branch ?? meta.branch;
  if (!branch) return null;
  const target = session.merge_target ?? meta.base_branch;
  return (
    <div
      data-testid="code-agent-session"
      className="border-t border-border pb-2.5 pl-11 pr-3.5 pt-2.5 text-[13px] text-foreground/80 dark:border-white/[.09] dark:text-[#ecece8]"
    >
      <code className={CODE}>{branch}</code>
      {target && (
        <>
          {' → '}
          <code className={CODE}>{target}</code>
        </>
      )}
      {session.pushed && ' · pushed'}
      {session.pr && (
        <>
          {' · '}
          <a
            href={session.pr.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="font-semibold text-[#e8507f] no-underline hover:underline"
          >
            PR #{session.pr.number}
          </a>
        </>
      )}
      {session.merged && ' · merged'}
    </div>
  );
}

/**
 * The backend's failure text verbatim (a LOCAL_TARGET_UNAVAILABLE message is
 * already the exact user-facing sentence); never re-worded on the client.
 */
function FailureBox({ meta, fallback }: { meta: CodeAgentMeta; fallback: string | null }) {
  const body: ReactNode = meta.failure_message ?? fallback;
  if (!body) return null;
  return (
    <div className="mx-3 mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
      <p
        data-testid="code-agent-failure"
        className="whitespace-pre-wrap text-sm text-red-600 dark:text-red-400"
      >
        {body}
      </p>
    </div>
  );
}

/** Mac app only: open this local session in Terminal.app (window.api.localCode). */
function OpenInTerminal({ taskId }: { taskId: string }) {
  const localCode = typeof window === 'undefined' ? undefined : window.api?.localCode;
  if (!localCode || taskId === 'pending') return null;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void localCode.openTerminal(taskId);
      }}
      className="whitespace-nowrap text-xs font-semibold text-[#e8507f] hover:underline"
    >
      Open in Terminal
    </button>
  );
}

interface DesktopCodeAgentChipProps {
  meta: CodeAgentMeta;
  vm: ClaudeCodeChipVM;
  events: CodeAgentTranscriptEvent[];
  toolCallId: string | undefined;
}

export function DesktopCodeAgentChip({ meta, vm, events, toolCallId }: DesktopCodeAgentChipProps) {
  const state = desktopChipState(meta, vm.chipState);
  const running = state === 'live' || state === 'verifying' || state === 'spinning_up';
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<ChipTab>('transcript');
  const echoes = useLocalEchoes(meta.task_id);
  const now = useNow(running);

  const startedAt = eventTimeMs(meta.started_at);
  const endedAt = running ? now : (eventTimeMs(meta.ended_at) ?? null);
  const elapsed = startedAt !== null && endedAt !== null ? formatElapsed(endedAt - startedAt) : '';

  const hasTranscript = events.length > 0 || echoes.length > 0;
  const isLive = state === 'live' || state === 'verifying';
  const showSummary = state === 'completed' && meta.summary;
  const session = !running && meta.code_session ? meta.code_session : null;
  const expandable = isLive || Boolean(showSummary) || hasTranscript || session !== null;
  const statusText =
    state === 'paused' && meta.usage_limit ? usageLimitPausedText(meta.usage_limit) : undefined;

  return (
    <div
      data-testid="code-agent-chip"
      data-code-agent-state={state}
      data-code-agent-target={meta.target}
      className="w-full overflow-hidden rounded-xl border border-border bg-card/50 backdrop-blur-sm dark:border-white/[.09] dark:bg-[#262624] dark:text-[#ecece8]"
    >
      <div
        onClick={() => expandable && setOpen((v) => !v)}
        className={`flex min-w-0 items-center gap-3 p-3 ${expandable ? 'cursor-pointer' : ''}`}
      >
        <ProviderIcon codeProvider={meta.provider} className="h-5 w-5 flex-shrink-0" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <StatusDisplay state={state} codeProvider={meta.provider} text={statusText} />
          {meta.title && (
            <span className={`truncate text-sm ${MUTED}`} data-testid="code-agent-title">
              · {meta.title}
            </span>
          )}
        </div>
        <span
          data-testid="code-agent-target"
          title={meta.target === 'local' ? meta.device_name : undefined}
          className={`whitespace-nowrap text-xs ${MUTED}`}
        >
          {codeAgentTargetLabel(meta)}
        </span>
        {isLive && meta.target === 'local' && <OpenInTerminal taskId={meta.task_id} />}
        {elapsed && (
          <span data-testid="code-agent-elapsed" className={`text-xs tabular-nums ${MUTED}`}>
            {elapsed}
          </span>
        )}
        <button
          type="button"
          aria-label={`Maximize ${codeAgentLabel(meta.provider)}`}
          onClick={(event) => {
            event.stopPropagation();
            vm.openFullscreen();
          }}
          className="rounded p-1 transition-colors hover:bg-muted dark:hover:bg-white/[.06]"
        >
          <Maximize2 className={`h-4 w-4 ${MUTED}`} />
        </button>
        {expandable &&
          (open ? (
            <ChevronUp className={`h-4 w-4 flex-shrink-0 ${MUTED}`} />
          ) : (
            <ChevronDown className={`h-4 w-4 flex-shrink-0 ${MUTED}`} />
          ))}
      </div>

      {meta.preview_url && (
        <CodeAgentPreviewCard
          taskId={meta.task_id}
          previewUrl={meta.preview_url}
          title={meta.title ?? null}
          provider={meta.provider}
        />
      )}

      {state === 'failed' && <FailureBox meta={meta} fallback={vm.failureMessage} />}

      {isLive && (
        <div className={open ? '' : 'hidden'}>
          <ChipTabs tab={tab} onChange={setTab} />
          <div className={tab === 'transcript' ? '' : 'hidden'}>
            <CodeAgentTranscript events={events} echoes={echoes} provider={meta.provider} />
          </div>
          <div className={tab === 'terminal' ? 'px-3 pt-2' : 'hidden'}>
            <TerminalSurface
              terminalContainerRef={vm.terminalContainerRef}
              className="h-[300px] rounded-lg"
            />
          </div>
          <CodeAgentSteerInput
            taskId={meta.task_id}
            toolCallId={toolCallId}
            provider={meta.provider}
          />
        </div>
      )}

      {open && session && <SessionLine session={session} meta={meta} />}

      {!isLive && open && showSummary && meta.summary && <Summary summary={meta.summary} />}

      {!isLive && open && !showSummary && hasTranscript && (
        <div className="border-t border-border pb-2 dark:border-white/[.09]">
          <CodeAgentTranscript events={events} echoes={echoes} provider={meta.provider} />
        </div>
      )}
    </div>
  );
}
