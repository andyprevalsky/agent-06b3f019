/** Explicit user-facing exceptions; routine tool status/results belong to work history. */
import type { Message } from '../hooks';
import { isSendMessageToUserRow, parsePinnedQuestion } from '../hooks/codeAgentContract';
import { isBrowserAgentResult } from './browserAgentResult';

export function isUserFacingWorkBoundary(message: Message): boolean {
  const metadata = message.metadata;
  // A finished browser agent (done/failed/stopped) is work: it folds into the
  // surrounding batch even when its row carries a recording pointer or the
  // auth-assistance resume block. A live login request (it carries a requestId
  // the user must answer) stays user-facing.
  const authRequest = metadata?.requestUserAuthentication as { requestId?: unknown } | undefined;
  if (isBrowserAgentResult(message) && !authRequest?.requestId) return false;
  const tool = metadata?.toolName;
  const failed = Boolean(
    metadata?.error || /failed|error/i.test(String(metadata?.toolStatus ?? '')),
  );
  const pending = !/^(finished|error|failed)$/i.test(String(metadata?.toolStatus ?? ''));
  const executeTransition =
    tool === 'attempt_completion' &&
    !failed &&
    (metadata?.phase === 'PLAN' || metadata?.title === 'Beginning Execute Phase');
  return Boolean(
    parsePinnedQuestion(metadata) ||
    message.file_pointer ||
    metadata?.inlineView ||
    metadata?.isUserAttentionMessage ||
    isSendMessageToUserRow(metadata) ||
    metadata?.isFinalSummary ||
    metadata?.completionSummary ||
    tool === 'completion_summary' ||
    tool === 'set_plan' ||
    tool === 'display' ||
    executeTransition ||
    (tool === 'attempt_completion_with_result' && !failed) ||
    // Existing code/preview cards must remain usable while the surrounding batch runs.
    tool === 'spawn_claude_code_agent' ||
    metadata?.requestUserSignup ||
    (metadata?.requestUserAuthentication && !metadata?.authAssistanceDeclined) ||
    (pending &&
      (metadata?.requestUserApproval ||
        tool === 'call_phone_number' ||
        /^(request_user_|ask_user)/.test(String(tool ?? '')))),
  );
}
