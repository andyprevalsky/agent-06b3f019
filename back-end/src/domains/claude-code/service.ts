/**
 * Claude Code domain service -- business logic for session management.
 */

import * as repo from './repo';
import {
  createClaudeCodeSession,
  closeClaudeCodeSession,
  getClaudeCodeSession,
} from '../../providers/e2b';
import { checkGithubRepoAccess } from '../../providers/github';
import { createLogger } from '../../providers/logger';
import {
  markPoolTokenRateLimited,
  markUserTokenRateLimited,
} from '../../providers/claudeCredentials';
import { markAnthropicApiKeyOnCooldown } from '../../providers/computeCredentials';
import { syncConnectionAfterIntegrationAuthFailure } from '../../providers/integrationConnectionSync';
import { createWithCodeSession } from '../../providers/codeSessions/spawn';

export type { HealthCheckResult } from './health';
export { checkSandboxHealth } from './health';

const log = createLogger('ClaudeCode');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class MissingUserIdError extends Error {
  constructor() {
    super('user_id is required when using github_repo_url');
    this.name = 'MissingUserIdError';
  }
}

export class GitHubAccessDeniedError extends Error {
  constructor(public detail: string) {
    super(detail);
    this.name = 'GitHubAccessDeniedError';
  }
}

export class AgentOwnerMismatchError extends Error {
  constructor() {
    super('The supplied user_id does not own this agent');
    this.name = 'AgentOwnerMismatchError';
  }
}

export class AgentContextLookupError extends Error {
  constructor() {
    super('Failed to resolve the agent owner and GitHub repository');
    this.name = 'AgentContextLookupError';
  }
}

// ---------------------------------------------------------------------------
// Create session
// ---------------------------------------------------------------------------

export type { CreateSessionParams, CreateSessionResult } from './types';
import type { CloseSessionParams, CreateSessionParams, CreateSessionResult } from './types';

/** Resolve the owning user and optional GitHub repo from the agent tree. */
export async function resolveAgentContext(
  agentId: string,
  userId: string | undefined
): Promise<{ repoUrl: string | undefined; userId: string | undefined }> {
  try {
    const agent = await repo.findAgentGithubInfo(agentId);
    let storedOwnerId = agent?.userId ?? undefined;
    let repoUrl = agent?.githubRepoUrl ?? undefined;

    if (
      repoUrl === undefined &&
      agent?.busId !== undefined &&
      agent.busId !== null &&
      agent.busId !== '' &&
      agent.busId !== agentId
    ) {
      const rootAgent = await repo.findRootAgentGithubInfo(agent.busId);
      repoUrl = rootAgent?.githubRepoUrl ?? undefined;
      storedOwnerId ??= rootAgent?.userId;
    }

    const callerUserId = userId !== undefined && userId !== '' ? userId : undefined;
    if (
      storedOwnerId !== undefined &&
      callerUserId !== undefined &&
      callerUserId !== storedOwnerId
    ) {
      throw new AgentOwnerMismatchError();
    }
    const resolvedUserId = storedOwnerId ?? callerUserId;

    if (agent?.githubRepoUrl !== undefined && agent.githubRepoUrl !== null) {
      return {
        repoUrl,
        userId: resolvedUserId,
      };
    }
    return { repoUrl, userId: resolvedUserId };
  } catch (err) {
    log.error('Failed to look up agent owner and GitHub repo', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof AgentOwnerMismatchError) throw err;
    throw new AgentContextLookupError();
  }
}

export async function createSession(params: CreateSessionParams): Promise<CreateSessionResult> {
  const { agent_id, goal, attachments, user_id } = params;
  let effectiveGithubRepoUrl = params.github_repo_url;
  let effectiveUserId = user_id;

  // The agents service does not need to duplicate the user ID on every internal
  // code-session request. Resolve ownership from the authoritative Agent row so
  // repo-less agents can still consume their user's stored OAuth credential.
  const resolved = await resolveAgentContext(agent_id, effectiveUserId);
  effectiveUserId = resolved.userId;

  // Auto-inject GitHub repo URL from the agent tree if not explicitly provided.
  if (effectiveGithubRepoUrl === undefined || effectiveGithubRepoUrl === '') {
    if (resolved.repoUrl !== undefined) {
      effectiveGithubRepoUrl = resolved.repoUrl;
      log.info(`Auto-injecting GitHub repo from agent tree: ${effectiveGithubRepoUrl}`);
    }
  }

  const attachmentCount = attachments !== undefined ? attachments.length : 0;
  log.info(`Creating session for agent ${agent_id}`, {
    attachments: attachmentCount > 0 ? String(attachmentCount) : undefined,
    github_repo: effectiveGithubRepoUrl ?? undefined,
  });

  // Check GitHub repo access if specified
  let normalizedRepoUrl: string | undefined;
  if (effectiveGithubRepoUrl !== undefined && effectiveGithubRepoUrl !== '') {
    if (effectiveUserId === undefined || effectiveUserId === '') {
      throw new MissingUserIdError();
    }

    const accessCheck = await checkGithubRepoAccess(effectiveUserId, effectiveGithubRepoUrl);
    if (!accessCheck.allowed) {
      log.info(`GitHub access denied for user ${effectiveUserId}: ${accessCheck.error ?? ''}`);
      throw new GitHubAccessDeniedError(accessCheck.error!);
    }
    normalizedRepoUrl = accessCheck.normalizedUrl!;
    log.info(`GitHub access granted for ${normalizedRepoUrl}`);
  }

  const { agentFastMode } = await import('../../providers/fastCacheStore');
  const fastMode = await agentFastMode(agent_id);
  // Code-agent Anthropic/Codex proxy is DEMO cache replay — not the Fast Mode button.
  const fastModeCacheEnabled = fastMode.enabled;

  const { session, fields } = await createWithCodeSession(
    {
      agentId: agent_id,
      userId: effectiveUserId,
      repoUrl: normalizedRepoUrl ?? null,
      codeProvider: 'claude',
      codeSessionId: params.code_session_id,
      leaseOwner: params.lease_owner,
    },
    (codeSession) =>
      createClaudeCodeSession(
        agent_id,
        goal,
        attachments,
        normalizedRepoUrl,
        effectiveUserId,
        fastModeCacheEnabled,
        codeSession
      )
  );

  return {
    task_id: session.taskId,
    sandbox_id: session.sandboxId,
    ws_url: session.wsUrl,
    uploaded_files: session.uploadedFiles,
    github_repo_url: normalizedRepoUrl ?? null,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// Close session
// ---------------------------------------------------------------------------

export type { CloseSessionParams } from './types';

export async function closeSession(params: CloseSessionParams) {
  const { task_id, user_id, agent_id, additional_paths } = params;

  const pathCount =
    additional_paths !== undefined && additional_paths.length > 0 ? additional_paths.length : 0;
  log.info(`Closing Claude Code session ${task_id}`, {
    additional_paths: pathCount > 0 ? String(pathCount) : undefined,
  });

  const result = await closeClaudeCodeSession(task_id, user_id, agent_id, additional_paths, {
    reason: params.reason,
  });

  return {
    status: 'CLOSED' as const,
    output_files: result.outputFiles,
    usage: result.usage,
    code_session: result.codeSession ?? null,
  };
}

// ---------------------------------------------------------------------------
// Get session
// ---------------------------------------------------------------------------

export async function getSession(taskId: string) {
  const session = await getClaudeCodeSession(taskId);

  if (session === undefined || session === null) {
    return null;
  }

  return {
    task_id: session.id,
    sandbox_id: session.sandboxId,
    stream_url: session.streamUrl,
    goal: session.goal,
    status: session.status,
    output: session.output,
    created_at: session.createdAt,
    closed_at: session.closedAt,
  };
}

// ---------------------------------------------------------------------------
// Get agent sessions
// ---------------------------------------------------------------------------

export async function getAgentSessions(agentId: string) {
  return repo.findSessionsByAgent(agentId);
}

// ---------------------------------------------------------------------------
// Persist output
// ---------------------------------------------------------------------------

export async function persistOutput(taskId: string, output: string) {
  log.info(`Persisting output for session ${taskId} (${output.length} bytes)`);
  await repo.persistSessionOutput(taskId, output);
  await detectAndMarkExhaustion(taskId, output);
}

/**
 * Long cooldown for credentials the inner Claude Code CLI rejected as
 * unauthenticated ("Please run /login"). This is structurally different from
 * a per-window rate limit — the OAuth refresh token is bad/revoked and won't
 * recover on its own, so we keep it out of rotation for a full day to give
 * operators time to re-sync. Unlike the rate-limit banner there's no inline
 * "resets at HH:MM" hint we can lean on.
 */
const POOL_AUTH_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Authentication-failure banners emitted by Claude Code when the cached
 * credentials envelope is unusable. These are NOT rate-limit signals — they
 * mean the OAuth tokens themselves were rejected, so the same envelope will
 * keep failing on every subsequent spawn until it's re-synced. Rotating the
 * pool token immediately is the only way to make the next agent succeed.
 */
const CREDENTIAL_AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /Please run \/login/i,
  /Not logged in/i,
  /Invalid authentication credentials/i,
  /API Error:\s*401\b.*OAuth access token has been revoked/i,
];

/** Billing/credit banners — rotate/cooldown the credential, but do not flip needs_reconnect. */
const BILLING_FAILURE_PATTERNS: readonly RegExp[] = [
  /Credit balance(?: is)? too low/i,
  /Add funds:\s*https:\/\/platform\.claude\.com\/settings\/billing/i,
];

const REVOKED_OAUTH_PATTERNS: readonly RegExp[] = [
  /API Error:\s*401\b.*OAuth access token has been revoked/i,
];

/**
 * Scan the persisted Claude Code terminal output for either the rate-limit
 * banner ("You've hit your limit · resets X:XX (UTC)") or an authentication-
 * failure banner ("Please run /login" / "Not logged in") and mark the
 * underlying Integration as rate-limited so subsequent spawns rotate to a
 * different pool token. Without this, a single broken OAuth envelope wedges
 * the entire pool (LRU keeps re-selecting it) and every retry burns an E2B
 * sandbox before failing to "/login".
 */
async function detectAndMarkExhaustion(taskId: string, output: string): Promise<void> {
  const rateLimitMatch = output.match(
    /You've hit your limit\s*·\s*resets\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*\(UTC\))/i
  );
  const isRateLimited = /You've hit your limit/i.test(output);
  const credentialAuthFailure = CREDENTIAL_AUTH_FAILURE_PATTERNS.some((re) => re.test(output));
  const billingFailure = BILLING_FAILURE_PATTERNS.some((re) => re.test(output));
  const authFailure = credentialAuthFailure || billingFailure;
  const revokedOauth = REVOKED_OAUTH_PATTERNS.some((re) => re.test(output));
  if (!isRateLimited && !authFailure) return;
  const sharedCredentialReason = authFailure
    ? 'claude_code_auth_failure'
    : 'claude_code_rate_limit';

  const session = await repo.findSessionById(taskId);
  if (session === null) {
    log.warn(`Claude Code credential failure detected for unknown session ${taskId}`);
    return;
  }
  const tokenSource = session.claudeTokenSource ?? '';
  if (tokenSource === '') {
    // A successfully created Claude session without a user/pool source used
    // the funded ANTHROPIC_API_KEY fallback. Back off that shared credential
    // so every subsequent spawn skips the known-broken key instead of burning
    // another E2B sandbox with the same terminal failure.
    log.warn(`Claude Code ${sharedCredentialReason} on funded ANTHROPIC_API_KEY for ${taskId}`);
    await markAnthropicApiKeyOnCooldown(sharedCredentialReason);
    return;
  }

  const resetUntil = rateLimitMatch !== null ? parseUtcResetTime(rateLimitMatch[1]) : null;
  const resetLabel = rateLimitMatch?.[1] ?? (authFailure ? 'auth-failure' : 'unknown');
  const integrationId = session.claudeTokenIntegrationId ?? '';

  // Auth-failure cooldown is longer than rate-limit cooldown because the
  // underlying problem (revoked/expired refresh token) won't fix itself.
  const cooldownMs = authFailure ? POOL_AUTH_FAILURE_COOLDOWN_MS : undefined;
  const failureKind = authFailure ? 'auth failure' : 'exhaustion';

  if (tokenSource === 'pool' && integrationId !== '') {
    log.warn(
      `Claude Code ${failureKind} on pool integration ${integrationId} (resets ${resetLabel})`
    );
    await markPoolTokenRateLimited(integrationId, {
      rateLimitedUntil: resetUntil,
      cooldownMs,
      failureReason: revokedOauth ? 'claude_code_auth_error' : undefined,
    });
  } else if (tokenSource === 'user' && session.agentId !== undefined) {
    const agent = await repo.findAgentById(session.agentId);
    const ownerId = agent?.userId ?? '';
    if (ownerId !== '') {
      log.warn(`Claude Code ${failureKind} on user ${ownerId} (resets ${resetLabel})`);
      await markUserTokenRateLimited(ownerId, {
        rateLimitedUntil: resetUntil,
        cooldownMs,
        failureReason: revokedOauth ? 'claude_code_auth_error' : undefined,
      });
    }
  } else if (tokenSource === 'anthropic') {
    log.warn(`Claude Code ${failureKind} on shared Anthropic API key`);
    await markAnthropicApiKeyOnCooldown(sharedCredentialReason);
  }

  // Non-revoked credential-auth banners ("Please run /login") only rate-limit the
  // Integration row for pool rotation; the chip still needs to prompt re-sync.
  // Billing/credit failures must not mark needs_reconnect — re-consent cannot fix them.
  if (credentialAuthFailure && !revokedOauth && integrationId !== '') {
    await syncConnectionAfterIntegrationAuthFailure({
      integrationId,
      failureReason: 'auth_error',
    });
  }
}

/**
 * Parse the reset-time fragment from Claude Code's exhaustion banner into an
 * absolute Date. The banner only includes the next-reset *time-of-day* in UTC,
 * so we anchor it to today/tomorrow depending on whether it has already passed.
 */
function parseUtcResetTime(fragment: string): Date | null {
  const match = fragment.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const now = new Date();
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0)
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}
