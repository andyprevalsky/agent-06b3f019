/**
 * STATE MACHINE: DesktopCodeAgentChip (Rose Desktop flag on AND metadata.code_agent present)
 *
 * LIFECYCLE (code_agent.state; a terminal task_complete message wins):
 *   [spinning_up] → header only (spinner · target)
 *   [live]        → header (pulsing dot · Active · running timer · target) + body
 *   [completed]   → header (check · Completed Successfully · duration · target) + summary
 *   [failed]      → header (✕ · Failed · duration · target) + red failure box (always shown)
 *
 * BODY: [OPEN] (default) ⇄ [CLOSED] via header click
 *   live:      TAB [TRANSCRIPT] (default) ⇄ [TERMINAL] (existing xterm, kept mounted)
 *              + "Message <agent> directly…" steer input
 *   completed: commit · branch · merged into · tests · files ± · Open preview
 *              (no summary → read-only transcript when events exist)
 *   failed:    read-only transcript when events exist
 *
 * Maximize opens the existing FullscreenView (owned by ClaudeCodeChip).
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Maximize2 } from 'lucide-react';

import {
  codeAgentLabel,
  codeAgentTargetLabel,
  eventTimeMs,
  localFailureText,
  type CodeAgentMeta,
  type CodeAgentSummary,
  type CodeAgentTranscriptEvent,
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

function FailureBox({ meta, fallback }: { meta: CodeAgentMeta; fallback: string | null }) {
  let body: ReactNode = meta.failure_message ?? fallback;
  if (meta.failure_kind) {
    const text = localFailureText(meta.failure_kind, meta.device_name);
    body = (
      <>
        <strong className="font-semibold">{text.lead}</strong> {text.rest}
      </>
    );
  }
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

interface DesktopCodeAgentChipProps {
  meta: CodeAgentMeta;
  vm: ClaudeCodeChipVM;
  events: CodeAgentTranscriptEvent[];
  agentId: string | null;
}

export function DesktopCodeAgentChip({ meta, vm, events, agentId }: DesktopCodeAgentChipProps) {
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
  const expandable = isLive || Boolean(showSummary) || hasTranscript;

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
          <StatusDisplay state={state} codeProvider={meta.provider} />
          {meta.title && (
            <span className={`truncate text-sm ${MUTED}`} data-testid="code-agent-title">
              · {meta.title}
            </span>
          )}
        </div>
        <span data-testid="code-agent-target" className={`whitespace-nowrap text-xs ${MUTED}`}>
          {codeAgentTargetLabel(meta)}
        </span>
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
          <CodeAgentSteerInput agentId={agentId} taskId={meta.task_id} provider={meta.provider} />
        </div>
      )}

      {!isLive && open && showSummary && meta.summary && <Summary summary={meta.summary} />}

      {!isLive && open && !showSummary && hasTranscript && (
        <div className="border-t border-border pb-2 dark:border-white/[.09]">
          <CodeAgentTranscript events={events} echoes={echoes} provider={meta.provider} />
        </div>
      )}
    </div>
  );
}
