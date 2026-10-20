/**
 * STATE MACHINE: CodeAgentConversationView (Rose Desktop; replaces the chat
 * column while a left-bar code-agent row is open — CodeAgentViewProvider)
 *
 * HEADER: provider icon · title · target/branch ("Cloud · rose-ui/polish/speed")
 *   · state text: [Running] spinning_up/live/verifying · [Paused] · [Completed] · [Failed]
 *   [Failed] → the backend's failure text (red box, verbatim)
 *   [Paused] → one muted line with the backend's text for the user (usage-limit
 *              stop included); no Retry (no user-callable resume route)
 * BODY: TAB [TRANSCRIPT] (default) ⇄ [TERMINAL] (the chip's xterm, kept mounted)
 *   transcript = thinking · messages · tool rows · agent-to-agent · "You → <agent>"
 *   ended: code-session line (branch → target · pushed · PR · merged) + summary
 * QUERY BOX (the normal one, text only, placeholder "Message <agent>…"):
 *   [IDLE] --Enter--> [SENDING] (POST /api/claude-code-session/:taskId/turns)
 *     --ok--> "You → <agent>" row in the transcript, box cleared → [IDLE]
 *     --error--> the backend's message as one plain line (a finished session's
 *               409 "This code session has finished…"), text kept → [IDLE]
 *   read-only views (shared recording, inspection, loading) → notice, no box
 * ESCAPE (not consumed by a dialog/menu) → close() (back to the owner's chat).
 */

import { useEffect, useState } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

import { useDirectTurn } from '../../hooks/codeAgentDirectTurn';
import { useLocalEchoes } from '../../hooks/codeAgentLocalState';
import { ProviderIcon, TerminalSurface } from '../claudeCodeChip.shared';
import { FailureBox, PausedNote, SessionLine, Summary } from '../codeAgentChip.desktop';
import { ChipTabs, CodeAgentTranscript, type ChipTab } from '../codeAgentChip.steer';
import { PinnedQuestionMount } from '../PinnedQuestion';
import QueryInput from '../QueryInput';
import { useCodeAgentView, type OpenCodeAgent } from './codeAgentViewState';
import { useCodeAgentConversation, type CodeAgentConversation } from './useCodeAgentConversation';

const MUTED = 'text-muted-foreground dark:text-[#a3a39d]';

function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Radix dialogs/menus prevent default when Escape dismisses them.
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
}

function Header({ c }: { c: CodeAgentConversation }) {
  return (
    <header data-testid="code-agent-view-header" className="flex items-center gap-3 px-3.5 pb-3">
      <ProviderIcon codeProvider={c.provider} className="h-6 w-6 flex-none" />
      <div className="min-w-0 flex-1">
        <h2
          data-testid="code-agent-view-title"
          className="truncate text-[15px] font-semibold text-foreground dark:text-[#ecece8]"
        >
          {c.title}
        </h2>
        {c.target && (
          <p
            data-testid="code-agent-view-target"
            title={c.meta?.target === 'local' ? c.meta.device_name : undefined}
            className={`truncate text-[12.5px] ${MUTED}`}
          >
            {c.target}
          </p>
        )}
      </div>
      <span
        data-testid="code-agent-view-state"
        className={cn(
          'whitespace-nowrap text-[13px]',
          c.stateText === 'Failed' ? 'text-red-600 dark:text-red-400' : MUTED,
        )}
      >
        {c.stateText}
      </span>
    </header>
  );
}

function Body({ c, taskId }: { c: CodeAgentConversation; taskId: string }) {
  const [tab, setTab] = useState<ChipTab>('transcript');
  const echoes = useLocalEchoes(taskId);
  const ended = c.chipState === 'completed' || c.chipState === 'failed' || c.chipState === 'paused';
  const session = ended ? c.meta?.code_session : undefined;
  return (
    <>
      <ChipTabs tab={tab} onChange={setTab} />
      <div className={tab === 'transcript' ? '' : 'hidden'}>
        <CodeAgentTranscript
          events={c.events}
          echoes={echoes}
          provider={c.provider}
          variant="page"
        />
      </div>
      <div className={tab === 'terminal' ? 'px-3 pt-2' : 'hidden'}>
        <TerminalSurface
          terminalContainerRef={c.vm.terminalContainerRef}
          className="h-[60vh] rounded-lg"
        />
      </div>
      {c.meta && session && <SessionLine session={session} meta={c.meta} />}
      {c.chipState === 'completed' && c.meta?.summary && <Summary summary={c.meta.summary} />}
    </>
  );
}

function Composer({
  c,
  taskId,
  opaqueSurface,
}: {
  c: CodeAgentConversation;
  taskId: string;
  opaqueSurface: boolean;
}) {
  const [text, setText] = useState('');
  const { send, sending, error } = useDirectTurn(taskId, c.toolCallId);
  const submit = async () => {
    if (await send(text)) setText('');
  };
  return (
    <div data-testid="code-agent-view-composer" className="relative z-10">
      <QueryInput
        directChannel
        opaqueSurface={opaqueSurface}
        value={text}
        onChange={setText}
        onSubmit={() => void submit()}
        disabled={sending}
        placeholder={`Message ${c.label}…`}
        showModelSelector={false}
        canSubmit
      />
      {error && (
        <p
          role="alert"
          data-testid="code-agent-view-error"
          className="mx-auto mt-1.5 max-w-4xl px-1 text-[13px] text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}

const NOOP = () => {};

export function CodeAgentConversationView({
  codeAgent,
  readOnlyMessage,
  opaqueSurface = false,
}: {
  codeAgent: OpenCodeAgent;
  /** Shared recording / inspection / loading: a notice replaces the query box. */
  readOnlyMessage: string | null;
  opaqueSurface?: boolean;
}) {
  const c = useCodeAgentConversation(codeAgent);
  useEscapeToClose(useCodeAgentView()?.close ?? NOOP);
  return (
    <>
      <ScrollArea className="relative flex-1 px-2 md:px-6">
        <div className="h-[var(--mobile-terminal-header-height)] md:h-24" />
        <section
          data-testid="code-agent-view"
          data-code-agent-id={codeAgent.taskId}
          data-code-agent-state={c.chipState}
          aria-label={`${c.label}: ${c.title}`}
          className="mx-auto max-w-4xl pb-6 text-foreground dark:text-[#ecece8]"
        >
          <Header c={c} />
          {c.meta && c.chipState === 'failed' && (
            <FailureBox meta={c.meta} fallback={c.vm.failureMessage} />
          )}
          {c.meta && <PausedNote meta={c.meta} className="-mt-1 px-3.5 pb-3" />}
          <Body c={c} taskId={codeAgent.taskId} />
        </section>
      </ScrollArea>
      <div className="rose-mobile-query-area relative shrink-0 pb-[var(--mobile-querybox-gap)] md:pb-6">
        {readOnlyMessage !== null ? (
          <div className={`relative z-10 pb-8 text-center text-sm ${MUTED}`}>{readOnlyMessage}</div>
        ) : (
          <>
            <PinnedQuestionMount />
            <Composer c={c} taskId={codeAgent.taskId} opaqueSurface={opaqueSurface} />
          </>
        )}
      </div>
    </>
  );
}
