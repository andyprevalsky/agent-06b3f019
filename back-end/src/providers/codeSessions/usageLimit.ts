import { randomUUID } from 'node:crypto';
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
 *   ├─ GET /credential-availability ──► codeCredentialTiers
 *   │     which subscription / funded credential of each provider is leasable
 *   │     right now (count queries, no decrypt, no lease) and next_credential:
 *   │     the provider the next spawn takes in the C15 order (credentialOrder.ts:
 *   │     every subscription before any funded key); with code_session_id also
 *   │     the session's own provider (P in that order) and the outlook, so a
 *   │     retry with nothing leasable stays paused and names the earliest reset
 *   └─ retry with code_session_id ──► next_credential; the same provider
 *         resumes the paused sandbox and the CLI's own conversation
 *         (`claude --resume` / Codex thread resume); switchCodeSessionProvider
 *         when that provider has no subscription left but the other one does
 *         (or only the other one's funded key is left): the new provider
 *         restores the checkpoint (same branch, commits, files), gets the
 *         previous CLI's session log as a file in the sandbox and a handoff
 *         prompt naming its path
 *
 * 10k agents: per call one indexed session read plus a few count queries
 * (and, on a usage limit or a blocked retry, one indexed read of the user's
 * accounts); no shared row is written except the exhausted credential itself.
 */
import { cliUsageLimitCooldown } from '../computeSubscriptionUsage';
import { prisma } from '../database';
import type { CodeAgentTier } from '../codeAgentModels';
import { createLogger } from '../logger';
import {
  hasExpiredClaudeCodeToken,
  markPoolTokenRateLimited,
  markUserTokenRateLimited,
} from '../claudeCredentials';
import {
  claudeCodeSandboxKeyUsable,
  resolveCodexAzureFunding,
  resolveCodexCodeAuthEnvs,
  type CodexAzureFunding,
} from '../claudeCodeSandboxAuth';
import {
  anthropicApiKeyCooldownUntil,
  isAnthropicApiKeyOnCooldown,
  markAnthropicApiKeyOnCooldown,
} from '../computeCredentials';
import {
  fetchGptCodeCredentialsWithMeta,
  markGptIntegrationRateLimited,
  type GptCodeCredentialEnvelopeResult,
  hasExpiredCodexToken,
} from '../gptCredentials';
import { isLocalDeviceSandboxId } from '../localDevices/hub';
import { checkpointKey, getCheckpointObject } from './artifactStore';
import { CLI_LOG_ARTIFACT } from './checkpoint';
import { excerpt, parseCodeEvents } from './codeEvents';
import {
  pickCodeCredential,
  type CodeCredentialStep,
  type CodeCredentialTiers,
  type CodeProvider,
} from './credentialOrder';
import { handoffTrajectoryPath, type HandoffTrajectory } from './handoffTrajectory';
export {
  handoffTrajectoryPath,
  writeHandoffTrajectory,
  type HandoffTrajectory,
  type SpawnCodeSession,
} from './handoffTrajectory';
import {
  CODE_SESSION_STATES,
  CodeSessionBusyError,
  findOwnedCodeSession,
  type CodeSessionRow,
} from './store';

const log = createLogger('CodeSessionUsageLimit');

export type { CodeProvider } from './credentialOrder';

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
  if (provider === 'codex') {
    // 'azure': the funded deployment serves the run (alone, or after an in-sandbox switch).
    if (source === 'azure' && !macSession) {
      await markCodexFundedCooldown(resetsAt);
      return { marked: 'codex_funded' };
    }
    if (integrationId !== '') {
      await markGptIntegrationRateLimited(integrationId, cliUsageLimitCooldown(resetsAt));
      return { marked: `gpt_integration:${integrationId}` };
    }
    if (macSession) return { marked: null };
    // No login: the run used the funded Azure deployment (the only funded
    // Codex path), so that deployment backs off until the reset.
    await markCodexFundedCooldown(resetsAt);
    return { marked: 'codex_funded' };
  }
  if (source === 'pool' && integrationId !== '') {
    await markPoolTokenRateLimited(integrationId, cliUsageLimitCooldown(resetsAt));
    return { marked: `claude_pool:${integrationId}` };
  }
  if (source === 'user') {
    const agent = await prisma.agent.findUnique({
      where: { id: task.agentId },
      select: { userId: true },
    });
    if (agent !== null) {
      await markUserTokenRateLimited(agent.userId, {
        ...cliUsageLimitCooldown(resetsAt),
        ...(integrationId !== '' ? { integrationId } : {}),
      });
      return { marked: `claude_user:${agent.userId}` };
    }
  }
  if (macSession) return { marked: null };
  await markAnthropicApiKeyOnCooldown('claude_code_rate_limit');
  return { marked: 'anthropic_api_key' };
}

/**
 * Whether a spawn could lease a `name` login right now (connected, not
 * rate-limited), own first, then shared pool. A login whose stored access token
 * has expired is not a subscription: serving skips it for the funded key.
 */
async function hasLeasableIntegration(
  userId: string,
  name: 'claude_code' | 'gpt_code',
  now: Date,
  ownOnly: boolean,
  excludeId?: string
): Promise<boolean> {
  const expired = name === 'claude_code' ? hasExpiredClaudeCodeToken : hasExpiredCodexToken;
  const where = {
    name,
    status: 'CONNECTED' as const,
    OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
    ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
  };
  const select = { id: true, config: true };
  const own = await prisma.integration.findMany({ where: { ...where, userId }, select });
  if (own.some((row) => !expired(row))) return true;
  if (ownOnly) return false;
  const pooled = await prisma.integration.findMany({
    where: { ...where, poolingEnabled: true },
    select,
  });
  return pooled.some((row) => !expired(row));
}

/** The funded key a Claude Code sandbox would use when no login is leased. */
async function claudeCodeFundedKeyUsable(): Promise<boolean> {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  return claudeCodeSandboxKeyUsable({
    claudeCodeAnthropicApiKey: process.env.CLAUDE_CODE_ANTHROPIC_API_KEY,
    anthropicApiKey,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    sharedKeyOnCooldown: anthropicApiKey ? await isAnthropicApiKeyOnCooldown() : false,
  });
}

// Sentinel singleton row for the funded Codex (Azure) deployment's backoff,
// the same no-FK pattern as the Anthropic / GPT key cooldowns; its name is
// outside the served ['claude_code','gpt_code'] set, so it is never leased.
const FUNDED_COOLDOWN_USER_ID = '00000000-0000-0000-0000-000000000000';
const CODEX_FUNDED_COOLDOWN_NAME = 'codex_funded_cooldown';
const DEFAULT_FUNDED_COOLDOWN_MS = 30 * 60 * 1000;

const codexFundedCooldownKey = {
  userId_name_accountId: {
    userId: FUNDED_COOLDOWN_USER_ID,
    name: CODEX_FUNDED_COOLDOWN_NAME,
    accountId: '',
  },
};

/** Back the funded Codex deployment off until the provider's reset (default 30 min). */
export async function markCodexFundedCooldown(resetsAt: Date | null): Promise<void> {
  const until =
    resetsAt !== null && resetsAt.getTime() > Date.now()
      ? resetsAt
      : new Date(Date.now() + DEFAULT_FUNDED_COOLDOWN_MS);
  await prisma.integration.upsert({
    where: codexFundedCooldownKey,
    create: {
      userId: FUNDED_COOLDOWN_USER_ID,
      name: CODEX_FUNDED_COOLDOWN_NAME,
      type: 'TOOL_SETUP',
      status: 'NOT_CONNECTED',
      rateLimitedUntil: until,
      failureReason: 'codex_code_usage_limit',
    },
    update: { rateLimitedUntil: until, failureReason: 'codex_code_usage_limit' },
  });
  log.warn('Funded Codex deployment backed off', { until: until.toISOString() });
}

/** When the funded Codex deployment's backoff ends; null when it is not backed off. */
export async function codexFundedCooldownUntil(now = new Date()): Promise<Date | null> {
  const row = await prisma.integration.findUnique({
    where: codexFundedCooldownKey,
    select: { rateLimitedUntil: true },
  });
  const until = row?.rateLimitedUntil ?? null;
  return until !== null && until > now ? until : null;
}

/** Test-only: clear the funded Codex backoff. */
export async function __resetCodexFundedCooldown(): Promise<void> {
  await prisma.integration.deleteMany({
    where: { userId: FUNDED_COOLDOWN_USER_ID, name: CODEX_FUNDED_COOLDOWN_NAME },
  });
}

/** The funded Azure Codex deployment a spawn may use now: configured and not backed off. */
export async function usableCodexAzureFunding(
  now = new Date(),
  tier: CodeAgentTier = 'flash'
): Promise<CodexAzureFunding | null> {
  const funding = resolveCodexAzureFunding(tier);
  if (funding === null) return null;
  return (await codexFundedCooldownUntil(now)) === null ? funding : null;
}

async function codexFundedUsable(now: Date): Promise<boolean> {
  return (await usableCodexAzureFunding(now)) !== null;
}

/** Which Codex credential serves a spawn: a ChatGPT login (own or shared pool) or the funded Azure deployment. */
export type CodexServedBy = 'user' | 'pool' | 'azure';

export interface CodexSpawnAuth {
  /** The ChatGPT login leased for the run; null when the funded Azure deployment serves it alone. */
  credentialMeta: GptCodeCredentialEnvelopeResult | null;
  /** Injected alongside a login for the in-sandbox runtime fallback; null when not configured or backed off. */
  azureFunding: CodexAzureFunding | null;
  envs: Record<string, string>;
  servedBy: CodexServedBy;
}

/**
 * The Codex credential a cloud spawn (E2B code agent, inspect) leases, in
 * order: the user's own ChatGPT login, a shared pool login, then the funded
 * Azure deployment unless it is backed off (codex_funded_cooldown). Throws
 * CodeAgentCredentialError when none is usable; a retry then stays paused on
 * the availability plan instead of starting a doomed run.
 *
 * The in-sandbox switch to Azure (the login proves unusable mid-run) is armed
 * only when Azure is the next credential after this login (credentialOrder.ts).
 * The sandbox cannot lease a login itself, so while another subscription
 * (Codex or Claude) is leasable the run fails to the parent instead, and its
 * retry takes that subscription (a Claude one with the provider handoff).
 */
export async function resolveCodexSpawnAuth(
  userId: string,
  now = new Date(),
  tier: CodeAgentTier = 'flash'
): Promise<CodexSpawnAuth> {
  const credentialMeta = await fetchGptCodeCredentialsWithMeta(userId);
  const funding = await usableCodexAzureFunding(now, tier);
  const leasedId = credentialMeta?.integrationId ?? credentialMeta?.poolTokenId;
  const azureFunding =
    credentialMeta !== null &&
    funding !== null &&
    (await otherSubscriptionLeasable(userId, leasedId, now))
      ? null
      : funding;
  const envs = resolveCodexCodeAuthEnvs(credentialMeta, azureFunding);
  return { credentialMeta, azureFunding, envs, servedBy: credentialMeta?.source ?? 'azure' };
}

/** Any Claude subscription, or a Codex one other than the leased login (own or shared). */
async function otherSubscriptionLeasable(
  userId: string,
  leasedCodexId: string | undefined,
  now: Date
): Promise<boolean> {
  return (
    (await hasLeasableIntegration(userId, 'claude_code', now, false)) ||
    (await hasLeasableIntegration(userId, 'gpt_code', now, false, leasedCodexId ?? ''))
  );
}

/**
 * Which subscription / funded credential of each provider a spawn could lease
 * right now. `ownOnly` (a Mac run) counts only the user's own logins: a local
 * session never receives a pool token or a funded key.
 */
export async function codeCredentialTiers(
  userId: string,
  now = new Date(),
  options: { ownOnly?: boolean } = {}
): Promise<CodeCredentialTiers> {
  const ownOnly = options.ownOnly === true;
  return {
    claude: {
      subscription: await hasLeasableIntegration(userId, 'claude_code', now, ownOnly),
      funded: !ownOnly && (await claudeCodeFundedKeyUsable()),
    },
    codex: {
      subscription: await hasLeasableIntegration(userId, 'gpt_code', now, ownOnly),
      funded: !ownOnly && (await codexFundedUsable(now)),
    },
  };
}

/** Whether a spawn could lease any Claude / Codex credential right now. */
export async function codeCredentialAvailability(
  userId: string,
  now = new Date(),
  options: { ownOnly?: boolean } = {}
): Promise<Record<CodeProvider, boolean>> {
  return anyTier(await codeCredentialTiers(userId, now, options));
}

function anyTier(tiers: CodeCredentialTiers): Record<CodeProvider, boolean> {
  return {
    claude: tiers.claude.subscription || tiers.claude.funded,
    codex: tiers.codex.subscription || tiers.codex.funded,
  };
}

/** The provider a live code session the user owns last ran on; null otherwise. */
export async function codeSessionProvider(
  userId: string,
  codeSessionId: string
): Promise<CodeProvider | null> {
  const session = await findOwnedCodeSession(userId, codeSessionId);
  if (session === null || session.state === CODE_SESSION_STATES.RETIRED) return null;
  return session.codeProvider === 'codex' ? 'codex' : 'claude';
}

/**
 * GET /credential-availability: what a spawn could lease now, and
 * `next_credential`, the provider (and tier) the spawn takes in the C15 order
 * (every subscription before any funded key, credentialOrder.ts). With a
 * `codeSessionId` (a retry or a resume from the root) the session's own
 * provider is P in that order (same harness, native resume) and the outlook
 * comes along, so a retry that can lease nothing stays paused and names every
 * path and the earliest reset instead of starting an agent.
 */
export async function codeSpawnCredentialPlan(
  userId: string,
  options: { ownOnly?: boolean; codeSessionId?: string; prefer?: CodeProvider; now?: Date } = {}
): Promise<
  Record<CodeProvider, boolean> & {
    next_credential: CodeCredentialStep | null;
    session_provider?: CodeProvider | null;
    outlook?: CodeUsageOutlook;
  }
> {
  const now = options.now ?? new Date();
  const tiers = await codeCredentialTiers(userId, now, { ownOnly: options.ownOnly });
  const available = anyTier(tiers);
  if (options.codeSessionId === undefined) {
    return {
      ...available,
      next_credential: pickCodeCredential(tiers, options.prefer ?? 'claude'),
    };
  }
  const sessionProvider = await codeSessionProvider(userId, options.codeSessionId);
  const prefer = sessionProvider ?? options.prefer ?? 'claude';
  const outlook = await codeUsageOutlook(userId, { prefer, now, ownOnly: options.ownOnly });
  return {
    ...available,
    next_credential: pickCodeCredential(tiers, prefer),
    session_provider: sessionProvider,
    outlook,
  };
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
 * What a respawn leases: the first leasable credential in the C15 order
 * (subscriptions before funded keys, the session's provider first), else the
 * account with the earliest reset.
 */
export interface CodeNextLease {
  provider: CodeProvider;
  /** The user's own account it takes, or the funded path's label; null for a shared pool account. */
  label: string | null;
  available_now: boolean;
  /** When nothing is available now: the earliest reset. */
  available_at: string | null;
  /** Own account, shared subscription pool or funded key: what it takes now, or whose reset is earliest. */
  kind?: 'own' | 'pool' | 'funded';
}

/**
 * A credential path that is not one of the user's own accounts: the shared
 * subscription pool or the funded key of a provider. Only stored state is
 * reported (pool counts, cooldown ends); remaining usage inside a window is
 * not stored anywhere, so it is never estimated.
 */
export interface CodeSharedPath {
  provider: CodeProvider;
  kind: 'pool' | 'funded';
  label: string;
  /** available | limited (until limited_until) | unconfigured (no such path here) */
  status: 'available' | 'limited' | 'unconfigured';
  limited_until: string | null;
  /** Pool only: shared subscriptions leasable now, of those connected. */
  available_count?: number;
  total_count?: number;
}

export interface CodeUsageOutlook {
  accounts: CodeAccountUsage[];
  /** Shared pool and funded paths (absent for a Mac run: it only uses own logins). */
  paths?: CodeSharedPath[];
  next_lease: CodeNextLease | null;
}

const PROVIDER_LABEL: Record<CodeProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

async function poolPath(provider: CodeProvider, now: Date): Promise<CodeSharedPath> {
  const name = provider === 'claude' ? 'claude_code' : 'gpt_code';
  const pooled = { name, status: 'CONNECTED' as const, poolingEnabled: true };
  const [total, availableCount, nextReset] = await Promise.all([
    prisma.integration.count({ where: pooled }),
    prisma.integration.count({
      where: { ...pooled, OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }] },
    }),
    prisma.integration.findFirst({
      where: { ...pooled, rateLimitedUntil: { gte: now } },
      orderBy: { rateLimitedUntil: 'asc' },
      select: { rateLimitedUntil: true },
    }),
  ]);
  return {
    provider,
    kind: 'pool',
    label: `shared ${PROVIDER_LABEL[provider]} subscriptions`,
    status: total === 0 ? 'unconfigured' : availableCount > 0 ? 'available' : 'limited',
    limited_until:
      total > 0 && availableCount === 0
        ? (nextReset?.rateLimitedUntil?.toISOString() ?? null)
        : null,
    available_count: availableCount,
    total_count: total,
  };
}

async function fundedPaths(now: Date): Promise<CodeSharedPath[]> {
  const claudeConfigured = [
    process.env.CLAUDE_CODE_ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.OPENROUTER_API_KEY,
  ].some((value) => (value ?? '').trim() !== '');
  const claudeUsable = claudeConfigured && (await claudeCodeFundedKeyUsable());
  const claudeUntil =
    claudeConfigured && !claudeUsable ? await anthropicApiKeyCooldownUntil(now) : null;
  const codexConfigured = resolveCodexAzureFunding() !== null;
  const codexUntil = codexConfigured ? await codexFundedCooldownUntil(now) : null;
  return [
    {
      provider: 'claude',
      kind: 'funded',
      label: 'funded Anthropic API key',
      status: !claudeConfigured ? 'unconfigured' : claudeUsable ? 'available' : 'limited',
      limited_until: claudeUntil?.toISOString() ?? null,
    },
    {
      provider: 'codex',
      kind: 'funded',
      label: 'funded Azure OpenAI deployment',
      status: !codexConfigured ? 'unconfigured' : codexUntil === null ? 'available' : 'limited',
      limited_until: codexUntil?.toISOString() ?? null,
    },
  ];
}

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
  const tiers = await codeCredentialTiers(userId, now, { ownOnly: options.ownOnly });
  // A Mac run only ever uses the user's own logins (C14): no shared paths.
  const paths =
    options.ownOnly === true
      ? undefined
      : [await poolPath('claude', now), await poolPath('codex', now), ...(await fundedPaths(now))];
  return {
    accounts,
    ...(paths !== undefined ? { paths } : {}),
    next_lease: pickNextLease(tiers, accounts, paths ?? [], options.prefer),
  };
}

/**
 * What a respawn leases: the first leasable credential in the C15 order
 * (pickCodeCredential: the preferred provider's subscriptions, the other's,
 * then the preferred funded key, then the other's); with nothing leasable, the
 * earliest reset of any limited path (own account, shared pool or funded key).
 */
export function pickNextLease(
  tiers: CodeCredentialTiers,
  accounts: CodeAccountUsage[],
  paths: CodeSharedPath[],
  prefer: CodeProvider
): CodeNextLease | null {
  const next = pickCodeCredential(tiers, prefer);
  if (next !== null) {
    const { provider } = next;
    if (next.tier === 'funded') {
      const funded = paths.find((path) => path.provider === provider && path.kind === 'funded');
      const label = funded?.label ?? null;
      return { provider, label, available_now: true, available_at: null, kind: 'funded' };
    }
    const own = accounts.find(
      (account) => account.provider === provider && account.status === 'available'
    );
    return {
      provider,
      label: own?.label ?? null,
      available_now: true,
      available_at: null,
      kind: own !== undefined ? 'own' : 'pool',
    };
  }
  const limited = [
    ...accounts.map((account) => ({ ...account, kind: 'own' as const })),
    ...paths,
  ].filter((path) => path.status === 'limited' && path.limited_until !== null);
  const earliest = limited.sort((a, b) =>
    String(a.limited_until).localeCompare(String(b.limited_until))
  )[0];
  if (earliest === undefined) return null;
  return {
    provider: earliest.provider,
    label: earliest.label,
    available_now: false,
    available_at: earliest.limited_until,
    kind: earliest.kind,
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
    select: {
      agentId: true,
      sandboxId: true,
      claudeTokenSource: true,
      claudeTokenIntegrationId: true,
    },
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
    // After a switch to Azure the limited run no longer used the login.
    thisRunIntegrationId: task.claudeTokenSource === 'azure' ? null : task.claudeTokenIntegrationId,
  });
}

const HANDOFF_EVENTS = 15;
/** Where the previous provider's CLI session log lands in the next sandbox (outside checkpoints). */

async function previousCliLog(session: CodeSessionRow): Promise<Buffer | null> {
  if (session.latestCheckpointSeq <= 0) return null;
  const key = checkpointKey(
    session.userId,
    session.id,
    session.latestCheckpointSeq,
    CLI_LOG_ARTIFACT
  );
  return getCheckpointObject(key).catch(() => null);
}

/**
 * The handoff prompt for the provider that takes the session over: resume the
 * previous agent's progress, where its trajectory file is, and its last
 * actions (a factual list from the log; no prose classifier).
 */
export function buildProviderHandoff(
  session: CodeSessionRow,
  cliLog: Buffer | null,
  trajectoryPath: string | null
): string {
  const lines: string[] = [];
  if (cliLog !== null) {
    for (const event of parseCodeEvents(session.codeProvider, cliLog).slice(-HANDOFF_EVENTS)) {
      lines.push(
        event.command !== undefined
          ? `- ran \`${excerpt(event.command, 200)}\` (exit ${event.exitCode ?? 'unknown'})`
          : `- edited ${event.editedFile ?? 'a file'}`
      );
    }
  }
  const previous = session.codeProvider === 'codex' ? 'Codex' : 'Claude Code';
  return [
    `Handoff: ${previous} worked on this task before you and stopped at a provider usage limit. ` +
      'Resume the progress it made; do not start over.',
    'Its commits and uncommitted files are already in your workspace' +
      (session.branch !== null ? ` on branch \`${session.branch}\`` : '') +
      '.',
    ...(trajectoryPath !== null
      ? [
          `Its full trajectory (the ${previous} session log, one JSON event per line) is at ` +
            `${trajectoryPath}. Read it to see what it did and what is left.`,
        ]
      : []),
    ...(lines.length > 0 ? ['Its last actions:', ...lines] : []),
  ].join('\n');
}

/**
 * A retry on the other provider: forget the paused sandbox (it runs the other
 * CLI's template) so the new sandbox restores the latest checkpoint, and drop
 * the other CLI's conversation id. Returns the handoff prompt for the goal and
 * the previous CLI's session log to write into the new sandbox.
 *
 * Exactly one spawn rotates a session: the provider change is a conditional
 * update on the provider and sandbox the caller read, so a concurrent
 * duplicate (the same tool call re-run by Temporal) loses with
 * CodeSessionBusyError instead of killing a second sandbox or restarting.
 */
export async function switchCodeSessionProvider(
  session: CodeSessionRow,
  provider: CodeProvider,
  killSandbox: (sandboxId: string) => Promise<void>
): Promise<{ session: CodeSessionRow; handoff: string; trajectory: HandoffTrajectory | null }> {
  const cliLog = await previousCliLog(session);
  const trajectory =
    cliLog !== null
      ? { path: handoffTrajectoryPath(session.id, session.codeProvider), content: cliLog }
      : null;
  const handoff = buildProviderHandoff(session, cliLog, trajectory?.path ?? null);
  const attemptOwner = `provider-switch:${randomUUID()}`;
  const { count } = await prisma.codeSession.updateMany({
    where: {
      id: session.id,
      codeProvider: session.codeProvider,
      sandboxId: session.sandboxId,
      leaseOwner: session.leaseOwner,
      leaseExpiresAt: session.leaseExpiresAt,
      state: { not: CODE_SESSION_STATES.RETIRED },
    },
    data: {
      codeProvider: provider,
      cliSessionId: null,
      sandboxKind: null,
      sandboxId: null,
      leaseOwner: attemptOwner,
    },
  });
  if (count !== 1) {
    log.warn('Code session was rotated by a concurrent spawn', {
      codeSessionId: session.id,
      to: provider,
    });
    throw new CodeSessionBusyError(session.id);
  }
  if (session.sandboxKind === 'e2b' && session.sandboxId !== null) {
    await killSandbox(session.sandboxId).catch((error: unknown) => {
      log.warn('Retiring the previous provider sandbox failed', {
        codeSessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  const updated = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
  log.info('Code session continues on another provider', {
    codeSessionId: session.id,
    from: session.codeProvider,
    to: provider,
    checkpointSeq: String(session.latestCheckpointSeq),
    trajectoryBytes: cliLog !== null ? String(cliLog.length) : undefined,
  });
  return { session: updated, handoff, trajectory };
}

/**
 * Undo a provider switch whose start failed: the session goes back to the
 * provider it came from (only if nothing else changed it since), so the next
 * retry rotates again and its new CLI gets the handoff and the trajectory.
 */
export { revertCodeSessionProvider } from './failedProviderRevert';
