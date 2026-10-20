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
 *     Shown as Paused with the backend's user text (no retry route, no Retry).
 *
 * Parsed defensively: anything missing or malformed yields undefined.
 */

import type { Message } from '@/lib/api/types';

import type { CodeAgentMeta, CodeAgentProvider } from './codeAgentContract';

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

/** C15 usage-limit stop: the CLI whose limit was hit and when it resets. */
export interface CodeAgentUsageLimit {
  provider: CodeAgentProvider;
  resets_at?: string;
}

/** "<CLI> usage limit reached[ · resets <local time>]" from the usage_limit block as sent. */
export function usageLimitDetails(limit: CodeAgentUsageLimit): string {
  const label = limit.provider === 'codex' ? 'Codex' : 'Claude Code';
  const resets = limit.resets_at ? Date.parse(limit.resets_at) : Number.NaN;
  if (!Number.isFinite(resets)) return `${label} usage limit reached`;
  const at = new Date(resets).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${label} usage limit reached · resets ${at}`;
}

/** The line under a paused session's status: the backend's text, else the usage-limit details. */
export function pausedNote(meta: CodeAgentMeta): string | undefined {
  if (meta.state !== 'paused') return undefined;
  return meta.pause_message ?? (meta.usage_limit ? usageLimitDetails(meta.usage_limit) : undefined);
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
