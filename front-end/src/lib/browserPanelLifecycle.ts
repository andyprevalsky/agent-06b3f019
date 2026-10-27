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

/**
 * A relaunched browser can reuse an ended run's task_id (prod agent 447576b9:
 * the root killed run 1 and spawned run 2 on the same task). An init after a
 * terminal starts a new run; only the latest run decides the chip.
 */
function currentBrowserRun(taskMessages: Message[]): Message[] {
  let start = 0;
  let ended = false;
  taskMessages.forEach((message, index) => {
    if (isBrowserTaskTerminalMessage(message)) ended = true;
    else if (ended && isBrowserInitMessage(message)) {
      start = index;
      ended = false;
    }
  });
  return taskMessages.slice(start);
}

/**
 * Browser status chip lifecycle:
 *
 * spawn_browser_agent init/browser/system/session_started
 *   -> [VISIBLE_STATUS_CHIP]
 *   -> browser URL events --sort by persisted event time--> [LATEST_LIVE_VIEW]
 *      (API hydration/realtime delivery order does not affect the selected URL)
 *   -> task-scoped browser progress messages
 *   -> terminal message, at either scope:
 *        - task-scoped (metadata.task_id set): action_type
 *          task_complete/session_paused, or legacy system/untyped
 *          spawn_browser_agent toolStatus FINISHED/ERROR
 *        - tool-call-scoped (no task_id, matched via the init message's
 *          toolCallId): same predicate — covers session_paused and the
 *          worker's generic tool-error path, which only knows the toolCallId
 *   -> auth_assistance FINISHED remains non-terminal and resumes this task
 *   -> [HIDDEN_STATUS_CHIP]
 *   -> a later init on the same task_id (relaunch, new tool call)
 *   -> [VISIBLE_STATUS_CHIP] for that run (earlier runs' terminals ignored)
 */
export function computeActiveBrowserPanels(messages: Message[]): BrowserPanelData[] {
  const panels: BrowserPanelData[] = [];
  const browserTaskIds = new Set<string>();
  const terminalToolCallIds = new Set<string>();
  const latestTaskByToolCallId = new Map<string, string>();

  [...messages].sort(compareBrowserMessageOrder).forEach((m) => {
    const taskId = m.metadata?.task_id;
    if (taskId && m.metadata?.toolName === 'spawn_browser_agent') {
      browserTaskIds.add(taskId);
    }
    const toolCallId = m.metadata?.toolCallId;
    if (taskId && toolCallId && isBrowserInitMessage(m)) {
      // A Temporal retry can allocate a new task id for the same logical tool
      // call. Its init supersedes the earlier attempt even if hydration or
      // realtime input does not contain the prior attempt's terminal event.
      latestTaskByToolCallId.set(toolCallId, taskId);
    }
    if (toolCallId && isToolCallScopedTerminalMessage(m)) {
      terminalToolCallIds.add(toolCallId);
    }
  });

  browserTaskIds.forEach((taskId) => {
    const taskMessages = currentBrowserRun(
      messages.filter((m) => m.metadata?.task_id === taskId).sort(compareBrowserMessageOrder),
    );
    const initMessage = taskMessages.find(isBrowserInitMessage);
    const initToolCallId = initMessage?.metadata?.toolCallId;
    const latestBrowserMessage = [...taskMessages]
      .reverse()
      .find(
        (m) =>
          typeof m.metadata?.browser_url === 'string' &&
          m.metadata.browser_url !== '' &&
          !BROWSER_CLEANUP_ACTION_TYPES.has(m.metadata.action_type ?? ''),
      );

    const hasTerminalTaskMessage = taskMessages.some(isBrowserTaskTerminalMessage);

    const isComplete =
      hasTerminalTaskMessage ||
      (typeof initToolCallId === 'string' && terminalToolCallIds.has(initToolCallId));
    const isSuperseded =
      typeof initToolCallId === 'string' && latestTaskByToolCallId.get(initToolCallId) !== taskId;

    if (!isComplete && !isSuperseded && initMessage) {
      panels.push({
        taskId,
        browserUrl:
          latestBrowserMessage?.metadata?.browser_url || initMessage.metadata?.browser_url || '',
      });
    }
  });

  return panels;
}
