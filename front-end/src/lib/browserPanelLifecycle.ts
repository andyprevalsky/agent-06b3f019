import type { Message } from './api';
import { BROWSER_INIT_ACTION_TYPES } from './backendToolNames';

export interface BrowserPanelData {
  taskId: string;
  browserUrl: string;
}

// ── Browser panels ────────────────────────────────────────────────────────

const TERMINAL_BROWSER_ACTION_TYPES = new Set([
  'task_complete',
  'session_paused',
  // User rejected a write-lock approval — the browser task ends without
  // task_complete (handler returns immediately). Prod agent c27b4f28
  // (2026-08-22): chip stayed visible after Aman rejected a 1-item checkout.
  'write_lock_rejected',
]);
const TERMINAL_BROWSER_TOOL_STATUSES = new Set(['FINISHED', 'ERROR']);

const BROWSER_CLEANUP_ACTION_TYPES = new Set(['diagnostics', 'network_recording', 'recording']);

function isBrowserInitMessage(message: Message): boolean {
  const actionType = message.metadata?.action_type;
  return (
    message.metadata?.toolName === 'spawn_browser_agent' &&
    typeof actionType === 'string' &&
    BROWSER_INIT_ACTION_TYPES.has(actionType) &&
    typeof message.metadata?.browser_url === 'string'
  );
}

// Terminality is declared by the producer, never inferred from the absence of a
// field. Every browser terminal carries an explicit action_type
// (agents/domains/spawn_browser_agent_v3/handler.py), enforced by
// agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::
// testBrowserToolEventsDeclareActionType.
//
// The untyped branch below is retained ONLY for tool-call scope (task_id ==
// null) so historical transcripts predating that contract still close their
// chips. It must never apply to a task-scoped message: workflow-scope progress
// events such as "Payment card ready" and "✓ Write permission granted" carry a
// task_id and are emitted between two halves of ONE live browser task, so
// treating them as terminal permanently hides a running browser
// (prod agent 7f354640-ffab-4098-b7ae-041ddf246c6f).
function isBrowserTaskTerminalMessage(message: Message): boolean {
  const actionType = message.metadata?.action_type;
  if (typeof actionType === 'string' && TERMINAL_BROWSER_ACTION_TYPES.has(actionType)) {
    return true;
  }

  return (
    message.metadata?.toolName === 'spawn_browser_agent' &&
    message.metadata?.subAgentId == null &&
    message.metadata?.task_id == null &&
    actionType == null &&
    typeof message.metadata?.toolStatus === 'string' &&
    TERMINAL_BROWSER_TOOL_STATUSES.has(message.metadata.toolStatus)
  );
}

// A terminal message posted at tool-call scope (no task_id) ends every browser
// task spawned by that tool call. The browser manager's catch-all error path
// (agents/domains/spawn_browser_agent_v3/handler.py, "Browser automation
// failed") posts failures this way — the exception can fire before/between
// tasks, so only the toolCallId is known and a task-scoped terminal message
// may never arrive. Task-scoped terminal messages (task_id set) must NOT
// close siblings: the same tool call can retry with a new task after one
// task's task_complete. Messages carrying subAgentId are excluded by
// isBrowserTaskTerminalMessage (task-scoped sub-agent actions are progress,
// not terminals).
function isToolCallScopedTerminalMessage(message: Message): boolean {
  return message.metadata?.task_id == null && isBrowserTaskTerminalMessage(message);
}

function getBrowserMessageTimestamp(message: Message): number {
  const timestamp = Date.parse(message.timestamp);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareBrowserMessageOrder(a: Message, b: Message): number {
  const timestampDelta = getBrowserMessageTimestamp(a) - getBrowserMessageTimestamp(b);
  if (timestampDelta !== 0) return timestampDelta;
  if (a.message_id < b.message_id) return -1;
  if (a.message_id > b.message_id) return 1;
  return 0;
}

interface BrowserPanelState extends BrowserPanelData {
  toolCallId: string | undefined;
  complete: boolean;
}

/**
 * Browser status chip lifecycle, reduced in persisted event order:
 *
 * [ABSENT] --browser/session_started/session_init (legacy system)--> [VISIBLE]
 * [VISIBLE] --current task/call terminal--> [HIDDEN]
 * [HIDDEN] --explicit session start or new invocation on same task--> [VISIBLE]
 * [HIDDEN] --verifier system / recording / diagnostics--> [HIDDEN]
 *
 * A task is a reusable BrowserSession identity. Only its current invocation's
 * terminal events close it; old-call cleanup cannot close a reopened session.
 * A retry's new task supersedes the previous task of the same tool call.
 */
export function computeActiveBrowserPanels(messages: Message[]): BrowserPanelData[] {
  const tasks = new Map<string, BrowserPanelState>();
  const terminalToolCallIds = new Set<string>();
  const latestTaskByToolCallId = new Map<string, string>();

  for (const m of [...messages].sort(compareBrowserMessageOrder)) {
    const {
      task_id: taskId,
      toolCallId,
      action_type: actionType,
      browser_url: url,
    } = m.metadata ?? {};
    let task = taskId ? tasks.get(taskId) : undefined;
    if (taskId && isBrowserInitMessage(m) && (!task || actionType !== 'system')) {
      // `browser` carries the spawn invocation id. Session/action events can
      // carry their own tool-call ids, so a rebind retains that invocation.
      const ownerCallId = actionType === 'browser' || !task ? toolCallId : task.toolCallId;
      task = { taskId, toolCallId: ownerCallId, browserUrl: url ?? '', complete: false };
      tasks.set(taskId, task);
      if (ownerCallId) {
        latestTaskByToolCallId.set(ownerCallId, taskId);
        terminalToolCallIds.delete(ownerCallId);
      }
    }
    const terminal = isBrowserTaskTerminalMessage(m);
    if (task && (!terminal || !toolCallId || !task.toolCallId || toolCallId === task.toolCallId)) {
      if (
        typeof url === 'string' &&
        url !== '' &&
        !BROWSER_CLEANUP_ACTION_TYPES.has(actionType ?? '')
      ) {
        task.browserUrl = url;
      }
      if (terminal) task.complete = true;
    }
    if (toolCallId && isToolCallScopedTerminalMessage(m)) {
      terminalToolCallIds.add(toolCallId);
    }
  }

  return [...tasks.values()]
    .filter(
      (task) =>
        !task.complete &&
        (!task.toolCallId ||
          (!terminalToolCallIds.has(task.toolCallId) &&
            latestTaskByToolCallId.get(task.toolCallId) === task.taskId)),
    )
    .map(({ taskId, browserUrl }) => ({ taskId, browserUrl }));
}
