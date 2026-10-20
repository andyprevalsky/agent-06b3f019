/**
 * "New agent in this branch" (code-agent-persistent-sessions.md §1b): an agent
 * created with `share_code_session_with` works in that agent's code session
 * (same worktree, branch and CLI conversation) instead of its own branch.
 */
import {
  CodeSessionShareTargetNotFoundError,
  shareCodeSession,
} from '../../providers/codeSessions/branch';
import * as repo from './repo';
import type { CreateAgentBody } from './types';

/** The share target must be an agent the caller owns. */
export async function assertCodeSessionShareTarget(
  body: CreateAgentBody,
  userId: string
): Promise<void> {
  const target = body.share_code_session_with;
  if (target !== undefined && (await repo.findAgent(target, userId)) === null) {
    throw new CodeSessionShareTargetNotFoundError(target);
  }
}

/** Recorded before the workflow starts so its first code spawn already shares. */
export async function recordCodeSessionShare(
  body: CreateAgentBody,
  userId: string,
  agentId: string
): Promise<void> {
  if (body.share_code_session_with === undefined) return;
  await shareCodeSession({ userId, agentId, sharedWithAgentId: body.share_code_session_with });
}
