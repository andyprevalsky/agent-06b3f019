/**
 * User tools: the side-effect record and the code-session runner behind the
 * agents worker (domains/user_tools). Internal callers only; every operation is
 * scoped to the authenticated user (X-User-Id).
 *
 *   worker ── claim ──► callRecords (ToolSideEffect)        side_effects only
 *          ── run ────► sessionRunner (user's code session)  executor code_session
 *          ── complete / release ──► callRecords
 */
import {
  claimUserToolCall,
  completeUserToolCall,
  releaseUserToolCall,
  type UserToolCallClaim,
  type UserToolRun,
} from '../../providers/userTools/callRecords';
import {
  runUserToolInCodeSession,
  UserToolRunError,
  type UserToolRunResult,
} from '../../providers/userTools/sessionRunner';
import type { UserToolRunBody } from './types';

export { UserToolRunError };

export function claimToolCall(
  userId: string,
  body: {
    idempotency_key: string;
    agent_id: string;
    tool: string;
    version_id: string;
    input_sha256: string;
  }
): Promise<UserToolCallClaim> {
  return claimUserToolCall(userId, body.idempotency_key, {
    agent_id: body.agent_id,
    tool: body.tool,
    version_id: body.version_id,
    input_sha256: body.input_sha256,
  });
}

export function completeToolCall(
  userId: string,
  key: string,
  run: UserToolRun
): Promise<UserToolRun | null> {
  return completeUserToolCall(userId, key, run);
}

export function releaseToolCall(userId: string, key: string, error: string): Promise<boolean> {
  return releaseUserToolCall(userId, key, error);
}

export function runTool(userId: string, body: UserToolRunBody): Promise<UserToolRunResult> {
  return runUserToolInCodeSession({
    userId,
    agentId: body.agent_id,
    versionId: body.version_id,
    tool: body.tool,
    runtime: body.runtime,
    entry: body.entry,
    files: body.files,
    timeoutS: body.timeout_s,
    inputJson: body.input_json,
    idempotencyKey: body.idempotency_key ?? null,
  });
}
