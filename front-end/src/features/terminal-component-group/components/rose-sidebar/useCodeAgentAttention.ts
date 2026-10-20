/**
 * Code agents (by task id = code_agent_id) waiting on the user, read from the
 * app-wide attention subscription (no extra channel, poll or fetch).
 *
 * Agent-tools question / approval rows a code agent raises carry
 * metadata.requestingAgent {kind 'code_agent', task_id} (and
 * metadata.sandboxTool.taskId); an unanswered one means that code agent's
 * left-bar row shows the amber needs-input glyph instead of the running one.
 * Without an AttentionRequestsProvider (isolated renders) the set is empty.
 */

import { useContext, useMemo } from 'react';

import { parseRequestingAgent } from '../../hooks/codeAgentContract';
import { AttentionRequestsContext } from '../attention-inbox/attentionRequestsContext';

const NONE: ReadonlySet<string> = new Set<string>();

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function useCodeAgentAttention(): ReadonlySet<string> {
  const requests = useContext(AttentionRequestsContext)?.requests;
  return useMemo(() => {
    if (!requests || requests.length === 0) return NONE;
    const taskIds = new Set<string>();
    for (const request of requests) {
      if (request.answered) continue;
      const metadata = record(request.metadata);
      const requester = parseRequestingAgent(metadata?.requestingAgent);
      const sandboxTask = record(metadata?.sandboxTool)?.taskId;
      const taskId =
        requester?.kind === 'code_agent' && requester.task_id
          ? requester.task_id
          : typeof sandboxTask === 'string'
            ? sandboxTask
            : null;
      if (taskId) taskIds.add(taskId);
    }
    return taskIds.size > 0 ? taskIds : NONE;
  }, [requests]);
}
