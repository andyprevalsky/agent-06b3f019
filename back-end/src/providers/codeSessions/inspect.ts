/**
 * Read-only code inspection: a short-lived code agent answers a question about
 * a code session's latest checkpoint (explore's `inspect_code`; root reaches it
 * through spawn_agent(type='explore')).
 *
 *   POST /api/claude-code-session/code-sessions/:id/inspect   (internal)
 *     │ caller agent must belong to the user and the session to that user ── else 404
 *     │ no checkpoint yet ─────────────────────────────────────────────────── 409
 *     ▼
 *   newest verified checkpoint: read only — the live session is never leased,
 *   resumed, paused or checkpointed, and its paused sandbox is never attached
 *     ▼
 *   NEW sandbox per call: default template, idle timeout kills (never pauses),
 *   no Rose MCP tools, user UI, skills, turn token or GitHub token
 *     ├─ applyCheckpoint (the same restore a resume uses)
 *     ├─ installInspectGuards (inspectSandbox.ts): wrappers, hooks, clean remote
 *     └─ headless CLI on the provider with a leasable credential (C15); a Claude
 *        usage limit marks that credential and retries once on Codex
 *     ▼
 *   answer + verified file:line citations + timings; finally: kill the sandbox
 *
 * Idempotent by construction: nothing outside the throwaway sandbox is written
 * (except an exhausted credential's cooldown), so a Temporal retry only re-asks.
 *
 * 10k agents: per call one indexed agent read, one session read, one checkpoint
 * download and one short-lived sandbox; no shared row, lock or channel.
 */
import { Sandbox } from 'e2b';
import { prisma } from '../database';
import { createLogger } from '../logger';
import {
  fetchClaudeCodeCredentialsWithMeta,
  markPoolTokenRateLimited,
  markUserTokenRateLimited,
  type ClaudeCodeCredentialResult,
} from '../claudeCredentials';
import { isAnthropicApiKeyOnCooldown, markAnthropicApiKeyOnCooldown } from '../computeCredentials';
import {
  CodeAgentCredentialError,
  resolveClaudeCodeAuthEnvs,
  resolveClaudeCodeSandboxApiKey,
  shouldIgnoreAnthropicApiKeyCooldownForSandbox,
  shouldSkipSandboxAnthropicGatewayForOauth,
} from '../claudeCodeSandboxAuth';
import { createSandboxWithRetry } from '../e2bSandboxCreate';
import { applyCheckpoint } from './checkpoint';
import { githubAuthRemoteUrl, loadNewestVerifiedCheckpoint, primaryRepoFacts } from './lifecycle';
import { type CodeSessionFs, e2bSandboxFs } from './sandboxFs';
import { CODE_SESSION_STATES, findOwnedCodeSession } from './store';
import { codeProviderOrder } from './credentialOrder';
import { codeCredentialTiers, parseResetsAt, resolveCodexSpawnAuth } from './usageLimit';
import {
  claudeHomeConfig,
  envFileContent,
  extractCitations,
  inspectorInstructions,
  inspectPaths,
  inspectRunScript,
  installInspectGuards,
  parseCliOutcome,
  verifyCitations,
  type InspectCitation,
  type InspectProvider,
} from './inspectSandbox';
import { DEFAULT_CODEX_CODE_TEMPLATE_ID } from '../codexTemplate';
import {
  claudeCodeModel,
  type CodeAgentSettings,
  type CodeAgentTier,
  codeAgentSettingsForAgent,
  codexCodeEffort,
  codexCodeModel,
} from '../codeAgentModels';
import { codexAzureModelCatalogFor } from '../e2bWsServerOverlay';

const log = createLogger('CodeInspect');

export const MAX_INSPECT_QUESTION_CHARS = 8000;
/** Hard backstop: E2B kills (never pauses) an inspection sandbox after this. */
const INSPECT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CLI_TIMEOUT_S = 480;

export class CodeInspectError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CodeInspectError';
  }
}

/** A throwaway sandbox for one inspection. `kill` is called exactly once. */
export interface InspectSandbox {
  fs: CodeSessionFs;
  sandboxId: string;
  kill(): Promise<void>;
}

export type InspectSandboxFactory = (provider: InspectProvider) => Promise<InspectSandbox>;

let sandboxFactoryOverride: InspectSandboxFactory | null = null;

/** Test seam: replace sandbox creation (owner checks, restore, guards and CLI run for real). */
export function setCodeInspectSandboxFactoryForTests(factory: InspectSandboxFactory | null): void {
  sandboxFactoryOverride = factory;
}

/**
 * E2B template per provider. The default (smallest) build of the provider's
 * code template; E2B_CODE_INSPECT_*_TEMPLATE_ID points at a smaller one.
 */
export function inspectTemplateId(provider: InspectProvider): string | null {
  if (provider === 'codex') {
    return (
      process.env.E2B_CODE_INSPECT_CODEX_TEMPLATE_ID?.trim() ||
      process.env.E2B_CODEX_CODE_TEMPLATE_ID?.trim() ||
      DEFAULT_CODEX_CODE_TEMPLATE_ID
    );
  }
  return (
    process.env.E2B_CODE_INSPECT_TEMPLATE_ID?.trim() ||
    process.env.E2B_CLAUDE_CODE_TEMPLATE_ID?.trim() ||
    null
  );
}

async function e2bInspectSandbox(provider: InspectProvider): Promise<InspectSandbox> {
  const apiKey = process.env.E2B_API_KEY;
  const templateId = inspectTemplateId(provider);
  if (apiKey === undefined || apiKey === '' || templateId === null) {
    throw new CodeInspectError(
      503,
      'CODE_INSPECT_SANDBOX_UNAVAILABLE',
      'E2B is not configured for code inspections'
    );
  }
  // No lifecycle option: the idle timeout kills the sandbox (a persistent
  // session pauses instead; an inspection must never linger).
  const sandbox = await createSandboxWithRetry(
    templateId,
    {
      apiKey,
      timeoutMs: INSPECT_SANDBOX_TIMEOUT_MS,
      envs: {},
      metadata: { purpose: 'code-inspect' },
    },
    'Code inspect'
  );
  return {
    fs: e2bSandboxFs(sandbox),
    sandboxId: sandbox.sandboxId,
    kill: async () => {
      await Sandbox.kill(sandbox.sandboxId, { apiKey });
    },
  };
}

function cliTimeoutS(): number {
  const raw = Number(process.env.CODE_INSPECT_CLI_TIMEOUT_S);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CLI_TIMEOUT_S;
}

/** CODE_INSPECT_*_MODEL, else the tier's code-agent model (codeAgentModels.ts). */
function inspectModel(provider: InspectProvider, tier: CodeAgentTier): string {
  if (provider === 'codex') {
    return (process.env.CODE_INSPECT_CODEX_MODEL ?? '').trim() || codexCodeModel(tier);
  }
  return (process.env.CODE_INSPECT_CLAUDE_MODEL ?? '').trim() || claudeCodeModel(tier);
}

interface ProviderAuth {
  envs: Record<string, string>;
  /** Claude credential the run leases, so a usage limit can rate-limit it (C15). */
  claude: ClaudeCodeCredentialResult | null;
}

/** Same credential order as a code-agent spawn (user → pool → funded key), no Fast Mode. */
async function providerAuth(
  provider: InspectProvider,
  userId: string,
  tier: CodeAgentTier
): Promise<ProviderAuth> {
  if (provider === 'codex') {
    return { envs: (await resolveCodexSpawnAuth(userId, new Date(), tier)).envs, claude: null };
  }
  const meta = await fetchClaudeCodeCredentialsWithMeta(userId);
  const shared = process.env.ANTHROPIC_API_KEY;
  const sharedOnCooldown = shared ? await isAnthropicApiKeyOnCooldown() : false;
  const transport = resolveClaudeCodeSandboxApiKey(
    process.env.CLAUDE_CODE_ANTHROPIC_API_KEY,
    shared,
    {
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      openrouterApiKey: process.env.OPENROUTER_API_KEY,
      sharedKeyOnCooldown: sharedOnCooldown,
    }
  );
  const envs: Record<string, string> = {};
  if (!shouldSkipSandboxAnthropicGatewayForOauth(meta) && transport.baseUrl) {
    envs.ANTHROPIC_BASE_URL = transport.baseUrl;
  }
  const ignoreCooldown = shouldIgnoreAnthropicApiKeyCooldownForSandbox({
    sandboxApiKey: transport.apiKey,
    sharedAnthropicApiKey: shared,
    sandboxBaseUrl: transport.baseUrl,
  });
  const keyOnCooldown = meta === null && !ignoreCooldown ? sharedOnCooldown : false;
  Object.assign(envs, resolveClaudeCodeAuthEnvs(meta, transport.apiKey, keyOnCooldown));
  return { envs, claude: meta };
}

/** C15: the Claude credential this run used is out until its reset. */
async function markClaudeUsageLimited(
  userId: string,
  meta: ClaudeCodeCredentialResult | null,
  resetsAt: Date | null
): Promise<void> {
  const until = resetsAt ?? undefined;
  if (meta?.source === 'pool' && meta.poolTokenId !== undefined) {
    await markPoolTokenRateLimited(meta.poolTokenId, { rateLimitedUntil: until });
  } else if (meta?.source === 'user') {
    await markUserTokenRateLimited(userId, { rateLimitedUntil: until });
  } else {
    await markAnthropicApiKeyOnCooldown('claude_code_rate_limit');
  }
}

/**
 * Providers to try in the C15 order (credentialOrder.ts): the session's own
 * provider's subscriptions, the other's, then the funded keys in that order.
 */
async function providerOrder(userId: string, preferred: string): Promise<InspectProvider[]> {
  const first: InspectProvider = preferred === 'codex' ? 'codex' : 'claude';
  return codeProviderOrder(await codeCredentialTiers(userId), first);
}

export interface InspectCodeParams {
  userId: string;
  /** The calling (explore / root) agent; must belong to userId. */
  agentId: string;
  codeSessionId: string;
  question: string;
  /** Aborted when the caller gave up: the sandbox is killed at once. */
  signal?: AbortSignal;
}

export interface InspectTimings {
  /** Sandbox create through guards installed: the inspector's startup time. */
  startup_ms: number;
  sandbox_ms: number;
  restore_ms: number;
  guard_ms: number;
  cli_ms: number;
  total_ms: number;
}

export interface CodeInspectionResult {
  status: 'answered' | 'failed' | 'usage_limited';
  code_session_id: string;
  checkpoint_seq: number;
  checkpoint_created_at: string;
  provider: InspectProvider | null;
  branch: string | null;
  head: string | null;
  work_dir: string | null;
  answer: string | null;
  citations: InspectCitation[];
  unverified_citations: string[];
  error: string | null;
  resets_at: string | null;
  sandbox_id: string | null;
  timings: InspectTimings;
}

interface Attempt {
  outcome: ReturnType<typeof parseCliOutcome>;
  citations: InspectCitation[];
  unverified: string[];
  sandboxId: string;
  timings: Omit<InspectTimings, 'total_ms'>;
}

function homeRelative(path: string): string {
  return path === '' ? '' : `/${path}`;
}

/** One inspection on one provider in one new sandbox; the sandbox is always killed. */
async function inspectOnce(
  provider: InspectProvider,
  auth: ProviderAuth,
  checkpoint: NonNullable<Awaited<ReturnType<typeof loadNewestVerifiedCheckpoint>>>,
  question: string,
  signal: AbortSignal | undefined,
  settings: CodeAgentSettings
): Promise<Attempt> {
  const started = Date.now();
  const sandbox = await (sandboxFactoryOverride ?? e2bInspectSandbox)(provider);
  let killed = false;
  const kill = async () => {
    if (killed) return;
    killed = true;
    await sandbox.kill().catch((error: unknown) => {
      log.warn('Killing the inspection sandbox failed (its timeout still kills it)', {
        sandboxId: sandbox.sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const onAbort = () => void kill();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const sandboxReady = Date.now();
    const { fs } = sandbox;
    await applyCheckpoint(fs, checkpoint, { authRemoteUrl: githubAuthRemoteUrl });
    const restored = Date.now();
    await installInspectGuards(fs, checkpoint.manifest);
    const paths = inspectPaths(fs.home);
    const repo = primaryRepoFacts(checkpoint.manifest);
    const workDir = `${fs.home}${homeRelative(repo?.path ?? '')}`;
    await fs.writeFile(paths.env, Buffer.from(envFileContent(auth.envs)));
    await fs.writeFile(paths.prompt, Buffer.from(question));
    await fs.writeFile(paths.instructions, Buffer.from(inspectorInstructions(workDir)));
    const azureCodex =
      provider === 'codex' &&
      auth.envs.CODEX_AUTH_JSON === undefined &&
      auth.envs.CODEX_AZURE_BASE_URL !== undefined;
    const azureCatalog = azureCodex
      ? codexAzureModelCatalogFor(auth.envs.CODEX_AZURE_MODEL ?? '')
      : null;
    if (azureCatalog !== null) await fs.writeFile(paths.codexAzureModelCatalog, azureCatalog);
    if (provider === 'claude') {
      await fs.writeFile(
        `${fs.home}/.claude.json`,
        Buffer.from(claudeHomeConfig(auth.envs.ANTHROPIC_API_KEY))
      );
    }
    const guarded = Date.now();
    log.info('Code inspection sandbox ready', {
      sandboxId: sandbox.sandboxId,
      provider,
      startupMs: String(guarded - started),
      restoreMs: String(restored - sandboxReady),
    });
    const timeoutS = cliTimeoutS();
    await fs.exec(
      inspectRunScript(
        {
          provider,
          workDir,
          timeoutS,
          ...(azureCodex
            ? {
                model: auth.envs.CODEX_AZURE_MODEL,
                codexAzureBaseUrl: auth.envs.CODEX_AZURE_BASE_URL,
                codexAzureModelCatalog: azureCatalog !== null,
              }
            : { model: inspectModel(provider, settings.tier) }),
          ...(provider === 'codex'
            ? { codexEffort: codexCodeEffort(settings.tier), codexSpeed: settings.speed }
            : {}),
        },
        paths,
        fs.home
      ),
      { timeoutMs: (timeoutS + 30) * 1000 }
    );
    const read = async (path: string) =>
      (await fs.readFile(path).catch(() => Buffer.alloc(0))).toString('utf8');
    const rcText = (await read(paths.rc)).trim();
    const exitCode = rcText === '' ? null : Number.parseInt(rcText, 10);
    const lastMessage = provider === 'codex' ? await read(paths.answer) : null;
    const outcome = parseCliOutcome(
      provider,
      await read(paths.out),
      await read(paths.err),
      Number.isFinite(exitCode) ? exitCode : null,
      lastMessage
    );
    const cliDone = Date.now();
    const { verified, unverified } =
      outcome.answer !== null
        ? await verifyCitations(fs, workDir, extractCitations(outcome.answer))
        : { verified: [], unverified: [] };
    return {
      outcome,
      citations: verified,
      unverified,
      sandboxId: sandbox.sandboxId,
      timings: {
        startup_ms: guarded - started,
        sandbox_ms: sandboxReady - started,
        restore_ms: restored - sandboxReady,
        guard_ms: guarded - restored,
        cli_ms: cliDone - guarded,
      },
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await kill();
  }
}

async function resolveOwnedSession(params: InspectCodeParams) {
  const notFound = () =>
    new CodeInspectError(404, 'CODE_SESSION_NOT_FOUND', 'Code session not found');
  const agent = await prisma.agent.findUnique({
    where: { id: params.agentId },
    select: { userId: true },
  });
  // The caller's own agent tree belongs to its user; another user's session
  // is indistinguishable from an unknown one.
  if (agent === null || agent.userId !== params.userId) throw notFound();
  const session = await findOwnedCodeSession(params.userId, params.codeSessionId);
  if (session === null || session.state === CODE_SESSION_STATES.RETIRED) throw notFound();
  return session;
}

/** Answer a question about the latest checkpoint of one of the caller's code sessions. */
export async function inspectCodeSession(params: InspectCodeParams): Promise<CodeInspectionResult> {
  const question = params.question.trim();
  if (question === '' || question.length > MAX_INSPECT_QUESTION_CHARS) {
    throw new CodeInspectError(
      400,
      'INVALID_QUESTION',
      `question must be 1-${MAX_INSPECT_QUESTION_CHARS} characters`
    );
  }
  const started = Date.now();
  const session = await resolveOwnedSession(params);
  if (session.latestCheckpointSeq < 1) {
    throw new CodeInspectError(
      409,
      'CODE_SESSION_NO_CHECKPOINT',
      'This code session has no checkpoint yet; inspect it after its code agent pauses or finishes'
    );
  }
  const checkpoint = await loadNewestVerifiedCheckpoint(session);
  if (checkpoint === null) {
    throw new CodeInspectError(
      409,
      'CODE_SESSION_NO_CHECKPOINT',
      'No checkpoint of this code session verifies'
    );
  }
  const repo = primaryRepoFacts(checkpoint.manifest);
  const providers = await providerOrder(params.userId, session.codeProvider);
  if (providers.length === 0) {
    throw new CodeInspectError(
      503,
      'CODE_CREDENTIALS_UNAVAILABLE',
      'No Claude Code or Codex credential is available right now'
    );
  }
  const base = {
    code_session_id: session.id,
    checkpoint_seq: checkpoint.manifest.seq,
    checkpoint_created_at: checkpoint.manifest.createdAt,
    branch: repo?.branch ?? null,
    head: repo?.head ?? null,
  };
  let last: (Attempt & { provider: InspectProvider }) | null = null;
  let resetsAt: Date | null = null;
  const settings = await codeAgentSettingsForAgent(params.agentId);
  const tier = settings.tier;
  for (const provider of providers) {
    let auth: ProviderAuth;
    try {
      auth = await providerAuth(provider, params.userId, tier);
    } catch (error) {
      if (error instanceof CodeAgentCredentialError) continue;
      throw error;
    }
    const attempt = await inspectOnce(
      provider,
      auth,
      checkpoint,
      question,
      params.signal,
      settings
    );
    last = { ...attempt, provider };
    const limit = attempt.outcome.usageLimit;
    if (limit === null || provider !== 'claude') break;
    // C15: this credential is out; the next provider (if any) answers instead.
    resetsAt = parseResetsAt(limit.resetsAt);
    await markClaudeUsageLimited(params.userId, auth.claude, resetsAt);
    log.info('Code inspection hit a Claude usage limit', {
      codeSessionId: session.id,
      resetsAt: resetsAt?.toISOString(),
    });
  }
  const totalMs = Date.now() - started;
  const emptyTimings = {
    startup_ms: 0,
    sandbox_ms: 0,
    restore_ms: 0,
    guard_ms: 0,
    cli_ms: 0,
  };
  const outcome = last?.outcome ?? null;
  const status: CodeInspectionResult['status'] =
    outcome?.answer !== null && outcome?.answer !== undefined
      ? 'answered'
      : outcome?.usageLimit !== null && outcome?.usageLimit !== undefined
        ? 'usage_limited'
        : 'failed';
  const result: CodeInspectionResult = {
    ...base,
    status,
    provider: last?.provider ?? null,
    work_dir: repo?.path ?? null,
    answer: outcome?.answer ?? null,
    citations: last?.citations ?? [],
    unverified_citations: last?.unverified ?? [],
    error:
      status === 'answered'
        ? null
        : (outcome?.error ?? 'No code-agent credential could be used for the inspection'),
    resets_at: status === 'usage_limited' ? (resetsAt?.toISOString() ?? null) : null,
    sandbox_id: last?.sandboxId ?? null,
    timings: { ...(last?.timings ?? emptyTimings), total_ms: totalMs },
  };
  log.info('Code inspection finished', {
    codeSessionId: session.id,
    agentId: params.agentId,
    status,
    provider: result.provider ?? undefined,
    checkpointSeq: String(result.checkpoint_seq),
    startupMs: String(result.timings.startup_ms),
    totalMs: String(totalMs),
    citations: String(result.citations.length),
  });
  return result;
}
