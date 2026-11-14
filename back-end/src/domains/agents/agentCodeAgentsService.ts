/**
 * Code agents (Claude Code / Codex sessions) for the agents list, batched by
 * root: GET /api/agents/code-agents?root_ids=<ids>.
 *
 * One indexed join per request over the caller's requested trees (at most
 * CODE_AGENT_LIST_MAX_ROOTS, newest CODE_AGENT_LIST_PER_ROOT each), so the
 * cost grows with the roots asked for, never with all of the user's agents.
 *
 * status is the task's own status, except PAUSED: the newest task of a live
 * (unretired) code session that closed resumably (idle, a user pause, a
 * question to its parent, a usage limit). The task row itself stays CLOSED
 * because the chip loads a task's output once it is CLOSED.
 */
import { z } from 'zod';
import { CODE_SANDBOX_IDLE_TIMEOUT_MS } from '../../providers/e2bCodeSessionSandbox';
import {
  CODE_AGENT_LIST_MAX_ROOTS,
  listCodeAgentsForRoots,
  renameCodeAgentForUser,
  type GraphCodeSessionRow,
  type RootCodeAgentRow,
} from './repoGraph';

export { renameCodeAgentForUser };

export const codeAgentsQuerySchema = z.object({
  root_ids: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.string().uuid()).min(1).max(CODE_AGENT_LIST_MAX_ROOTS)),
});

export type CodeAgentProvider = 'claude' | 'codex' | null;

/** The CLI a code agent ran; null for legacy rows that never recorded it. */
export function codeAgentProvider(
  row: Pick<GraphCodeSessionRow, 'codeProvider'>
): CodeAgentProvider {
  return row.codeProvider === 'claude' || row.codeProvider === 'codex' ? row.codeProvider : null;
}

/** Close reasons that leave the session resumable (paused, never failed). */
const RESUMABLE_CLOSE_REASONS = new Set(['idle', 'awaiting_parent', 'usage_limit', 'cancel']);

/** ACTIVE | COMPLETED | CLOSED | ERROR | PAUSED */
export function codeAgentListStatus(
  row: Pick<RootCodeAgentRow, 'status' | 'closeReason' | 'latestOfLiveSession'>
): string {
  const resumable =
    row.status === 'CLOSED' &&
    row.closeReason !== null &&
    RESUMABLE_CLOSE_REASONS.has(row.closeReason) &&
    row.latestOfLiveSession;
  return resumable ? 'PAUSED' : row.status;
}

export interface CodeAgentAwaitingParent {
  question: string;
  at: string;
}

/** The pending question to the spawning agent, while the task is live or paused. */
export function codeAgentAwaitingParent(
  status: string,
  awaitingParent: unknown
): CodeAgentAwaitingParent | null {
  if (status !== 'ACTIVE' && status !== 'PAUSED') return null;
  if (awaitingParent === null || typeof awaitingParent !== 'object') return null;
  const { question, at } = awaitingParent as Record<string, unknown>;
  if (typeof question !== 'string' || question === '') return null;
  return { question, at: typeof at === 'string' ? at : '' };
}

/** The spawn's task_name, else (legacy rows) the goal's first non-empty line. */
export function codeAgentTitle(row: Pick<RootCodeAgentRow, 'taskName' | 'goal'>): string {
  const taskName = row.taskName?.trim();
  if (taskName !== undefined && taskName !== '') return taskName;
  return (row.goal.split('\n').find((line) => line.trim() !== '') ?? '').trim();
}

/** Whether the code agent's container runs: awake | stopped (resumable) | destroyed. */
export type CodeAgentContainerState = 'awake' | 'stopped' | 'destroyed';

/**
 * The container behind a code agent's task, from its persistent code session
 * (one sandbox per session, shared by every task attached to it): a retired
 * session is destroyed. It is awake while some task of the session runs (this
 * one, or a later spawn attached to the same live sandbox) on an ACTIVE session
 * whose keepalive (spawn.ts refreshes lastActiveAt with the sandbox timeout) is
 * within E2B's idle window: E2B pauses an idle sandbox itself (onTimeout
 * 'pause') without writing CodeSession.state, and a resume leases the session
 * (ACTIVE, lastActiveAt now) before its sandbox connects and its task row
 * exists, so a bare lease never reads awake. Anything else is stopped (it
 * resumes on the next message). Without a persistent session (Mac and legacy
 * runs) only a running task is known: awake, else unknown (null).
 */
export function codeAgentContainerState(
  row: Pick<
    RootCodeAgentRow,
    'status' | 'sessionState' | 'sessionLastActiveAt' | 'sessionHasActiveTask'
  >,
  now = Date.now()
): CodeAgentContainerState | null {
  if (row.sessionState === null) return row.status === 'ACTIVE' ? 'awake' : null;
  if (row.sessionState === 'RETIRED') return 'destroyed';
  const lastActive = row.sessionLastActiveAt ? new Date(row.sessionLastActiveAt).getTime() : 0;
  const fresh = now - lastActive < CODE_SANDBOX_IDLE_TIMEOUT_MS;
  return row.sessionHasActiveTask && row.sessionState === 'ACTIVE' && fresh ? 'awake' : 'stopped';
}

export interface CodeAgentListItem {
  code_agent_id: string;
  owner_agent_id: string;
  root_agent_id: string;
  provider: CodeAgentProvider;
  status: string;
  /** Persistent code session this task ran in (null for Mac and legacy runs). */
  code_session_id: string | null;
  /** Question it asked its spawning agent and is waiting on, if any. */
  awaiting_parent: CodeAgentAwaitingParent | null;
  /** The spawn's task_name; legacy rows without one show the goal's first line. */
  title: string;
  /** Its container: awake | stopped | destroyed; null when unknown (no persistent session). */
  container_state: CodeAgentContainerState | null;
  created_at: Date;
}

export async function listCodeAgents(
  userId: string,
  rootIds: string[]
): Promise<{ code_agents: CodeAgentListItem[] }> {
  const rows = await listCodeAgentsForRoots(userId, [...new Set(rootIds)]);
  return {
    code_agents: rows.map((row) => {
      const status = codeAgentListStatus(row);
      return {
        code_agent_id: row.id,
        owner_agent_id: row.agentId,
        root_agent_id: row.rootAgentId,
        provider: codeAgentProvider(row),
        status,
        code_session_id: row.codeSessionId,
        awaiting_parent: codeAgentAwaitingParent(status, row.awaitingParent),
        title: codeAgentTitle(row),
        container_state: codeAgentContainerState(row),
        created_at: row.createdAt,
      };
    }),
  };
}
