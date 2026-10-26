/**
 * Code-agent conversation: existing main-chat messages with one work slot per
 * native turn. Running activity updates in place; finished work collapses
 * above its answer. No terminal view (transcript only). User messages,
 * displays and A2A rows stay outside the slot.
 * The existing QueryInput sends directly with attachments and native settings;
 * questions and approvals sit above it without replacing the draft. Read-only
 * views keep the transcript and show a notice instead of the composer.
 */

import { useEffect, useState } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

import { useAgentContext } from '../../hooks';
import { messageRequester } from '../../hooks/codeAgentContract';
import { derivePendingApproval } from '@/lib/pendingApproval';
import ApprovalChip from '../ApprovalChip';
import { CodeSessionMessages } from './CodeSessionMessages';
import { CodeSessionComposer } from './CodeSessionComposer';
import { useLocalEchoes } from '../../hooks/codeAgentLocalState';
import { ProviderIcon } from '../claudeCodeChip.shared';
import { FailureBox, PausedNote, SessionLine, Summary } from '../codeAgentChip.desktop';
import { PinnedQuestionMount } from '../PinnedQuestion';
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
  const echoes = useLocalEchoes(taskId);
  const ended = c.chipState === 'completed' || c.chipState === 'failed' || c.chipState === 'paused';
  const session = ended ? c.meta?.code_session : undefined;
  return (
    <>
      <div className="border-t border-border dark:border-white/[0.07]">
        <CodeSessionMessages c={c} taskId={taskId} echoes={echoes} />
      </div>
      {c.meta && session && <SessionLine session={session} meta={c.meta} />}
      {c.chipState === 'completed' && c.meta?.summary && <Summary summary={c.meta.summary} />}
    </>
  );
}

const NOOP = () => {};

export function CodeAgentConversationView({
  codeAgent,
  readOnlyMessage,
}: {
  codeAgent: OpenCodeAgent;
  /** Shared recording / inspection / loading: a notice replaces the query box. */
  readOnlyMessage: string | null;
  opaqueSurface?: boolean;
}) {
  const c = useCodeAgentConversation(codeAgent);
  const { messages } = useAgentContext();
  const [handledApprovals, setHandledApprovals] = useState<Set<string>>(() => new Set());
  const pending = derivePendingApproval(
    messages.filter((message) => messageRequester(message.metadata)?.task_id === codeAgent.taskId),
  );
  const approval = pending && !handledApprovals.has(pending.attentionRequestId) ? pending : null;
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
            {approval && (
              <ApprovalChip
                pendingApproval={approval}
                onApprovalHandled={() =>
                  setHandledApprovals((previous) =>
                    new Set(previous).add(approval.attentionRequestId),
                  )
                }
              />
            )}
            <CodeSessionComposer key={codeAgent.taskId} c={c} taskId={codeAgent.taskId} />
          </>
        )}
      </div>
    </>
  );
}
