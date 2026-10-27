/**
 * C15: a code agent stopped on a provider usage limit and must resume on the
 * next available credential (or the other provider) from its saved session.
 *
 *   agents activity ─ structured limit event (rate_limit_event rejected /
 *   │                 Codex codex_error_info usage_limit_exceeded)
 *   ├─ POST /:taskId/usage-limit ──► markCodeTaskUsageLimited
 *   │     the task's credential row gets rateLimitedUntil (pool / user
 *   │     integration) or the shared funded key goes on cooldown — the same
 *   │     markers and columns the credential pools already read. The answer
 *   │     carries the user's connected accounts and what a respawn would
 *   │     lease (codeUsageOutlook) for the parent, which decides what to do.
 *   ├─ GET /credential-availability ──► codeCredentialAvailability
 *   │     is any Claude / Codex credential leasable right now (count queries,
 *   │     no decrypt, no lease)
 *   └─ respawn with code_session_id ──► any credential that is not
 *         rate-limited; switchCodeSessionProvider when the provider changed:
 *         the new provider restores the checkpoint (same branch, commits,
 *         files) and gets a handoff summary of the transcript
 *
 * 10k agents: per call one indexed session read plus at most four count
 * queries (and, on a usage limit, one indexed read of the user's accounts);
 * no shared row is written except the exhausted credential itself.
 */
import { prisma } from '../database';
import { createLogger } from '../logger';
import { markPoolTokenRateLimited, markUserTokenRateLimited } from '../claudeCredentials';
import { isAnthropicApiKeyOnCooldown, markAnthropicApiKeyOnCooldown } from '../computeCredentials';
import {
  isGptApiKeyOnCooldown,
  markGptApiKeyOnCooldown,
  markGptIntegrationRateLimited,
} from '../gptCredentials';
import { isLocalDeviceSandboxId } from '../localDevices/hub';
import { checkpointKey, getCheckpointObject } from './artifactStore';
import { CLI_LOG_ARTIFACT } from './checkpoint';
import { excerpt, parseCodeEvents } from './codeEvents';
import type { CodeSessionRow } from './store';

const log = createLogger('CodeSessionUsageLimit');

export type CodeProvider = 'claude' | 'codex';

/** Seconds, milliseconds or an ISO string → Date; null when absent or invalid. */
export function parseResetsAt(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Mark the credential the task ran on as rate-limited until the reset. */
export async function markCodeTaskUsageLimited(
  taskId: string,
  provider: CodeProvider,
  resetsAt: Date | null
): Promise<{ marked: string | null }> {
  const task = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: {
      agentId: true,
      sandboxId: true,
      claudeTokenSource: true,
      claudeTokenIntegrationId: true,
    },
  });
  if (task === null) return { marked: null };
  // A Mac session (C14) never receives a pool token or a funded key, so its
  // limit never puts those on cooldown.
  const macSession = isLocalDeviceSandboxId(task.sandboxId);
  const source = task.claudeTokenSource ?? '';
  const integrationId = task.claudeTokenIntegrationId ?? '';
  const until = resetsAt ?? undefined;
  if (provider === 'codex') {
    if (integrationId !== '') {
      await markGptIntegrationRateLimited(integrationId, { rateLimitedUntil: until });
      return { marked: `gpt_integration:${integrationId}` };
    }
    if (macSession) return { marked: null };
    await markGptApiKeyOnCooldown('codex_code_usage_limit');
    return { marked: 'gpt_api_key' };
  }
  if (source === 'pool' && integrationId !== '') {
    await markPoolTokenRateLimited(integrationId, { rateLimitedUntil: until });
    return { marked: `claude_pool:${integrationId}` };
  }
  if (source === 'user') {
    const agent = await prisma.agent.findUnique({
      where: { id: task.agentId },
      select: { userId: true },
    });
    if (agent !== null) {
      await markUserTokenRateLimited(agent.userId, {
        rateLimitedUntil: until,
        ...(integrationId !== '' ? { integrationId } : {}),
      });
      return { marked: `claude_user:${agent.userId}` };
    }
  }
  if (macSession) return { marked: null };
  await markAnthropicApiKeyOnCooldown('claude_code_rate_limit');
  return { marked: 'anthropic_api_key' };
}

async function hasLeasableIntegration(
  userId: string,
  name: string,
  now: Date,
  ownOnly: boolean
): Promise<boolean> {
  const notLimited = [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }];
  const own = await prisma.integration.count({
    where: { userId, name, status: 'CONNECTED', OR: notLimited },
  });
  if (own > 0 || ownOnly) return own > 0;
  const pooled = await prisma.integration.count({
    where: { name, status: 'CONNECTED', poolingEnabled: true, OR: notLimited },
  });
  return pooled > 0;
}

/**
 * Whether a spawn could lease a Claude / Codex credential right now.
 * `ownOnly` (a Mac run) counts only the user's own logins: a local session
 * never receives a pool token or a funded key.
 */
export async function codeCredentialAvailability(
  userId: string,
  now = new Date(),
  options: { ownOnly?: boolean } = {}
): Promise<Record<CodeProvider, boolean>> {
  const ownOnly = options.ownOnly === true;
  const claude =
    (await hasLeasableIntegration(userId, 'claude_code', now, ownOnly)) ||
    (!ownOnly && Boolean(process.env.ANTHROPIC_API_KEY) && !(await isAnthropicApiKeyOnCooldown()));
  const codex =
    (await hasLeasableIntegration(userId, 'gpt_code', now, ownOnly)) ||
    (!ownOnly && Boolean(process.env.GPT_API_KEY) && !(await isGptApiKeyOnCooldown()));
  return { claude, codex };
}

/** One of the user's connected Claude Code / Codex accounts, as the parent sees it. */
export interface CodeAccountUsage {
  provider: CodeProvider;
  /** Account email, else "<provider> account <n>". */
  label: string;
  /** available | limited (until limited_until) | reconnect (the user must reconnect it) */
  status: 'available' | 'limited' | 'reconnect';
  limited_until: string | null;
  /** The account the limited run used. */
  this_run: boolean;
}

/**
 * What a respawn leases: any credential that is not rate-limited (the
 * session's provider first), else the account with the earliest reset.
 */
export interface CodeNextLease {
  provider: CodeProvider;
  /** The user's own account it takes; null for a shared pool account or the funded key. */
  label: string | null;
  available_now: boolean;
  /** When nothing is available now: the earliest reset. */
  available_at: string | null;
}

export interface CodeUsageOutlook {
  accounts: CodeAccountUsage[];
  next_lease: CodeNextLease | null;
}

const PROVIDER_LABEL: Record<CodeProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * The user's connected accounts with what is stored about their limits, and
 * what a respawn would lease now (C15). Reads stored state only: one indexed
 * Integration read for the user plus the availability counts; no provider
 * calls. Remaining usage inside a window is not stored, so it is not reported.
 */
export async function codeUsageOutlook(
  userId: string,
  options: {
    prefer: CodeProvider;
    now?: Date;
    ownOnly?: boolean;
    thisRunIntegrationId?: string | null;
  }
): Promise<CodeUsageOutlook> {
  const now = options.now ?? new Date();
  const rows = await prisma.integration.findMany({
    where: { userId, name: { in: ['claude_code', 'gpt_code'] } },
    select: { id: true, name: true, status: true, rateLimitedUntil: true, accountEmail: true },
    orderBy: { createdAt: 'asc' },
  });
  const seen: Record<CodeProvider, number> = { claude: 0, codex: 0 };
  const accounts = rows.map((row): CodeAccountUsage => {
    const provider: CodeProvider = row.name === 'gpt_code' ? 'codex' : 'claude';
    seen[provider] += 1;
    const limitedUntil =
      row.rateLimitedUntil !== null && row.rateLimitedUntil > now ? row.rateLimitedUntil : null;
    const email = row.accountEmail?.trim() ?? '';
    return {
      provider,
      label: email !== '' ? email : `${PROVIDER_LABEL[provider]} account ${seen[provider]}`,
      status:
        row.status !== 'CONNECTED' ? 'reconnect' : limitedUntil !== null ? 'limited' : 'available',
      limited_until: limitedUntil?.toISOString() ?? null,
      this_run: row.id === options.thisRunIntegrationId,
    };
  });
  const available = await codeCredentialAvailability(userId, now, { ownOnly: options.ownOnly });
  const other: CodeProvider = options.prefer === 'claude' ? 'codex' : 'claude';
  for (const provider of [options.prefer, other]) {
    if (!available[provider]) continue;
    const own = accounts.find(
      (account) => account.provider === provider && account.status === 'available'
    );
    return {
      accounts,
      next_lease: { provider, label: own?.label ?? null, available_now: true, available_at: null },
    };
  }
  const earliest = accounts
    .filter((account) => account.status === 'limited')
    .sort((a, b) => String(a.limited_until).localeCompare(String(b.limited_until)))[0];
  return {
    accounts,
    next_lease:
      earliest === undefined
        ? null
        : {
            provider: earliest.provider,
            label: earliest.label,
            available_now: false,
            available_at: earliest.limited_until,
          },
  };
}

/**
 * POST /:taskId/usage-limit: mark the task's credential limited until the
 * reset, then answer the user's accounts and the next lease for the parent.
 */
export async function reportCodeTaskUsageLimit(
  taskId: string,
  provider: CodeProvider,
  resetsAt: Date | null
): Promise<{ marked: string | null; resets_at: string | null } & Partial<CodeUsageOutlook>> {
  const { marked } = await markCodeTaskUsageLimited(taskId, provider, resetsAt);
  const outlook = await codeUsageOutlookForTask(taskId, provider);
  return { marked, resets_at: resetsAt?.toISOString() ?? null, ...(outlook ?? {}) };
}

/** The outlook for the user who owns `taskId` (returned with a usage-limit report). */
export async function codeUsageOutlookForTask(
  taskId: string,
  provider: CodeProvider
): Promise<CodeUsageOutlook | null> {
  const task = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: { agentId: true, sandboxId: true, claudeTokenIntegrationId: true },
  });
  if (task === null) return null;
  const agent = await prisma.agent.findUnique({
    where: { id: task.agentId },
    select: { userId: true },
  });
  if (agent === null) return null;
  return codeUsageOutlook(agent.userId, {
    prefer: provider,
    ownOnly: isLocalDeviceSandboxId(task.sandboxId),
    thisRunIntegrationId: task.claudeTokenIntegrationId,
  });
}

const HANDOFF_EVENTS = 15;

/** Short factual summary of what the previous provider's CLI did (no prose classifier). */
export async function buildProviderHandoff(session: CodeSessionRow): Promise<string> {
  const lines: string[] = [];
  if (session.latestCheckpointSeq > 0) {
    const key = checkpointKey(
      session.userId,
      session.id,
      session.latestCheckpointSeq,
      CLI_LOG_ARTIFACT
    );
    const cliLog = await getCheckpointObject(key).catch(() => null);
    if (cliLog !== null) {
      for (const event of parseCodeEvents(session.codeProvider, cliLog).slice(-HANDOFF_EVENTS)) {
        lines.push(
          event.command !== undefined
            ? `- ran \`${excerpt(event.command, 200)}\` (exit ${event.exitCode ?? 'unknown'})`
            : `- edited ${event.editedFile ?? 'a file'}`
        );
      }
    }
  }
  const previous = session.codeProvider === 'codex' ? 'Codex' : 'Claude Code';
  return [
    `Handoff: ${previous} worked on this task before you and stopped at a provider usage limit.`,
    'Its commits and uncommitted files are already in your workspace' +
      (session.branch !== null ? ` on branch \`${session.branch}\`` : '') +
      '. Continue from that state; do not start over.',
    ...(lines.length > 0 ? ['Its last actions:', ...lines] : []),
  ].join('\n');
}

/**
 * A retry on the other provider: forget the paused sandbox (it runs the other
 * CLI's template) so the new sandbox restores the latest checkpoint, and drop
 * the other CLI's conversation id. Returns the handoff summary for the goal.
 */
export async function switchCodeSessionProvider(
  session: CodeSessionRow,
  provider: CodeProvider,
  killSandbox: (sandboxId: string) => Promise<void>
): Promise<{ session: CodeSessionRow; handoff: string }> {
  const handoff = await buildProviderHandoff(session);
  if (session.sandboxKind === 'e2b' && session.sandboxId !== null) {
    await killSandbox(session.sandboxId).catch((error: unknown) => {
      log.warn('Retiring the previous provider sandbox failed', {
        codeSessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  const updated = await prisma.codeSession.update({
    where: { id: session.id },
    data: { codeProvider: provider, cliSessionId: null, sandboxKind: null, sandboxId: null },
  });
  log.info('Code session continues on another provider', {
    codeSessionId: session.id,
    from: session.codeProvider,
    to: provider,
    checkpointSeq: String(session.latestCheckpointSeq),
  });
  return { session: updated, handoff };
}
