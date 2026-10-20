/**
 * W5b persistent code-session wire shapes (feat/rose-user-ui @ f78bf8aa8), read
 * by codeAgentContract.latestCodeAgentMeta for the desktop chip. Split from the
 * contract adapter only for size; the contract re-exports its public names.
 *
 *   metadata.code_session {code_session_id, branch, merge_target, pushed, pr, merged, …}
 *     (spawn_claude_code_agent _merge_close_code_session_facts; latest row wins)
 *   C15 usage-limit stop: the spawn's final row carries failure_kind 'usage_limit' +
 *     retryable + usage_limit{provider, resets_at, …} + retry{tool, type,
 *     code_session_id}; the activity's own row has action_type 'usage_limit'.
 *
 * Parsed defensively: anything missing or malformed yields undefined.
 */

import type { Message } from '@/lib/api/types';

import type { CodeAgentProvider } from './codeAgentContract';

/** `metadata.code_session.pr`: the newest PR GitHub reports for the branch. */
export interface CodeSessionPullRequest {
  number: number;
  url: string;
  merged: boolean;
}

/** `message.metadata.code_session` (the persistent code session's facts). */
export interface CodeSessionFacts {
  code_session_id: string;
  branch?: string;
  /** Where the branch merges back (the spawner's branch or the default branch). */
  merge_target?: string;
  pushed: boolean;
  pr?: CodeSessionPullRequest;
  /** True only once GitHub confirms the merge and the target contains head. */
  merged: boolean;
}

/** C15 usage-limit stop: the CLI whose limit was hit; the retry continues on the other one. */
export interface CodeAgentUsageLimit {
  provider: CodeAgentProvider;
  resets_at?: string;
}

/** "Paused - usage limit, resumes on <the other CLI>" (claude ↔ codex). */
export function usageLimitPausedText(limit: CodeAgentUsageLimit): string {
  return `Paused - usage limit, resumes on ${limit.provider === 'codex' ? 'Claude Code' : 'Codex'}`;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cliProvider(value: unknown): CodeAgentProvider | null {
  return value === 'claude' || value === 'codex' ? value : null;
}

export function parseCodeSession(value: unknown): CodeSessionFacts | undefined {
  const r = rec(value);
  const id = str(r?.code_session_id);
  if (!r || !id) return undefined;
  const pr = rec(r.pr);
  const prNumber = typeof pr?.number === 'number' ? pr.number : undefined;
  const prUrl = str(pr?.url);
  return {
    code_session_id: id,
    branch: str(r.branch),
    merge_target: str(r.merge_target),
    pushed: r.pushed === true,
    pr:
      pr && prNumber !== undefined && prUrl
        ? { number: prNumber, url: prUrl, merged: pr.merged === true }
        : undefined,
    merged: r.merged === true,
  };
}

/**
 * The C15 stop, with the exhausted CLI: the spawn's final row (failure_kind
 * 'usage_limit' + retryable) or the activity's own row (action_type 'usage_limit').
 */
export function parseUsageLimit(metadata: Message['metadata']): CodeAgentUsageLimit | undefined {
  const action: unknown = metadata?.action_type;
  const finalRow = metadata?.failure_kind === 'usage_limit' && metadata.retryable === true;
  if (!metadata || (!finalRow && action !== 'usage_limit')) return undefined;
  const limit = rec(metadata.usage_limit);
  const prov = cliProvider(limit?.provider) ?? cliProvider(metadata.code_provider);
  if (!prov) return undefined;
  return { provider: prov, resets_at: str(limit?.resets_at) };
}
