/**
 * STATE MACHINE: CodeAgentConversationView (Rose Desktop code-agent view)
 *
 * A code agent's conversation in the EXISTING root transcript and query box, no
 * display of its own:
 *   transcript  → MessageList inside CodeAgentContextProvider (the code session as
 *                 the selected agent): its goal and the person's turns as user
 *                 messages, every tool / thought row folded into "Worked for …",
 *                 the answer after it. Running: the live work row + thinking.
 *   devbox usage → CodeResourcesIndicator (CPU · memory · disk) while it runs
 *   preview      → OpenAppButton when the session has a dev-server preview_url
 *                  (opens the full-screen app view; moved off the root row)
 *   failed      → the backend's failure text (FailureBox) · paused → PausedNote
 *   query box   → CodeSessionComposer (QueryInput: model chip, speed toggle, nub
 *                 with the session's context usage, direct delivery)
 *   read-only views (shared recording / inspection / loading) → a notice
 *                 replaces the query box.
 * Escape closes the view (back to the owner's chat).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';

import { useAgentContext } from '../../hooks';
import { messageRequester } from '../../hooks/codeAgentContract';
import { useDirectTurn } from '../../hooks/codeAgentDirectTurn';
import { codeSessionSettings } from '../../hooks/codeSessionSettings';
import { derivePendingApproval } from '@/lib/pendingApproval';
import ApprovalChip from '../ApprovalChip';
import { MessageList } from '../MessageList';
import { CodeSessionComposer } from './CodeSessionComposer';
import { FailureBox, PausedNote } from '../codeAgentChip.desktop';
import { PinnedQuestionMount } from '../PinnedQuestion';
import { useCodeAgentView, type OpenCodeAgent } from './codeAgentViewState';
import { CodeResourcesIndicator } from '../CodeResourcesIndicator';
import { OpenAppButton } from '../app-view/OpenAppButton';
import { CodeAgentContextProvider } from './CodeAgentContext';
import { useCodeAgentConversation } from './useCodeAgentConversation';

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

const NOOP = () => {};

export function CodeAgentConversationView({
  codeAgent,
  readOnlyMessage,
  backdrop,
}: {
  codeAgent: OpenCodeAgent;
  /** Shared recording / inspection / loading: a notice replaces the query box. */
  readOnlyMessage: string | null;
  /** The root transcript's blur overlay (AgentChatArea passes BlurOverlay). */
  backdrop?: ReactNode;
}) {
  const { taskId } = codeAgent;
  const c = useCodeAgentConversation(codeAgent);
  const { messages } = useAgentContext();
  const settings = useMemo(() => codeSessionSettings(messages, taskId), [messages, taskId]);
  const turn = useDirectTurn(taskId, c.toolCallId);
  const [handledApprovals, setHandledApprovals] = useState<Set<string>>(() => new Set());
  const pending = derivePendingApproval(
    messages.filter((message) => messageRequester(message.metadata)?.task_id === taskId),
  );
  const approval = pending && !handledApprovals.has(pending.attentionRequestId) ? pending : null;
  const running = c.stateText === 'Running';
  useEscapeToClose(useCodeAgentView()?.close ?? NOOP);
  return (
    <>
      <ScrollArea className="relative flex-1 px-2 md:px-6">
        {backdrop}
        <div className="h-[var(--mobile-terminal-header-height)] md:h-24" />
        <section
          data-testid="code-agent-view"
          data-code-agent-id={taskId}
          data-code-agent-state={c.chipState}
          aria-label={`${c.label}: ${c.title}`}
          className="relative z-20 mx-auto max-w-4xl text-foreground dark:text-[#ecece8]"
        >
          {(running || c.meta?.preview_url) && (
            <div className="flex items-center justify-end gap-3 pb-2">
              {c.meta?.preview_url && (
                <OpenAppButton
                  taskId={taskId}
                  previewUrl={c.meta.preview_url}
                  title={c.meta.title ?? null}
                  provider={c.provider}
                />
              )}
              <CodeResourcesIndicator taskId={taskId} running={running} />
            </div>
          )}
          {c.meta && c.chipState === 'failed' && (
            <FailureBox meta={c.meta} fallback={c.vm.failureMessage} flush />
          )}
          {c.meta && <PausedNote meta={c.meta} className={`pb-3 ${MUTED}`} />}
          <CodeAgentContextProvider taskId={taskId} c={c} settings={settings} onSend={turn.send}>
            <MessageList showStatusBanners={false} />
          </CodeAgentContextProvider>
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
            <CodeSessionComposer
              key={taskId}
              c={c}
              taskId={taskId}
              settings={settings}
              turn={turn}
            />
          </>
        )}
      </div>
    </>
  );
}
