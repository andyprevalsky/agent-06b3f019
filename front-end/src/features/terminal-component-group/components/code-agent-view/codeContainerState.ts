/**
 * Whether a code agent's container (its code session's sandbox) is on, for the
 * code-agent view's query box (CodeContainerStatus):
 *   the task spinning up / live (transcript snapshot)            → awake
 *   else the code-agents list's container_state (CodeSession.state +
 *     E2B idle window, read by the left bar) when read after this run
 *     ended (meta.ended_at)                                         → it
 *   else the session state the run's close reported (it arrives on the
 *     owner's realtime channel, so the dot flips without a refetch)  → ACTIVE awake ·
 *     PAUSED stopped · RETIRED destroyed
 *   none of these (Mac and legacy runs)                           → null (unknown)
 */

import type { CodeAgentListItem, CodeContainerState } from '@/lib/api/tree';

import { eventTimeMs, type CodeAgentMeta } from '../../hooks/codeAgentContract';

const SESSION_STATE: Record<string, CodeContainerState> = {
  ACTIVE: 'awake',
  PAUSED: 'stopped',
  RETIRED: 'destroyed',
};

export function codeContainerState(
  meta: CodeAgentMeta | null,
  listed: { item: CodeAgentListItem; readAt: number } | null,
): CodeContainerState | null {
  if (meta?.state === 'live' || meta?.state === 'spinning_up') return 'awake';
  const listState = listed?.item.container_state ?? null;
  // The list counts only once it has seen this run end: its row no longer ACTIVE, and
  // (when the end time is known) read after it. Both, since the read time is the
  // client's clock and ended_at the worker's. Otherwise the run's own close
  // (realtime, on the transcript) decides.
  const endedAt = eventTimeMs(meta?.ended_at);
  const listFresh =
    listed !== null &&
    (!meta || (listed.item.status !== 'ACTIVE' && (endedAt === null || listed.readAt > endedAt)));
  if (listState && listFresh) return listState;
  const closed = meta?.code_session?.state;
  return closed ? (SESSION_STATE[closed] ?? null) : null;
}

export const CONTAINER_LABEL: Record<CodeContainerState, string> = {
  awake: 'Container awake',
  stopped: 'Container stopped (resumes when you send a message)',
  destroyed: 'Container destroyed',
};
