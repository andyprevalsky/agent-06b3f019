import { prisma } from './database';
import { createLogger } from './logger';
import {
  buildFastModeAnthropicEnv,
  buildFastModeCodexEnv,
  resolveFastModeWriteEnabled,
} from './codeAgentFastModeEnv';
import type { FilePointer } from './storage';
import { v4 as uuidv4 } from 'uuid';
import {
  fetchClaudeCodeCredentialsWithMeta,
  type ClaudeCodeCredentialResult,
} from './claudeCredentials';
import { isAnthropicApiKeyOnCooldown } from './computeCredentials';
import {
  fetchGptCodeCredentialsWithMeta,
  isGptApiKeyOnCooldown,
  type GptCodeCredentialEnvelopeResult,
} from './gptCredentials';
import { buildCodeAgentSystemPrompt, buildCodexHarnessSystemPrompt } from './codeAgentPrompt';
import { withAgentGraphInstructions } from './agentGraph/cli';
import { uploadAttachmentsToSandbox } from './e2bAttachments';
import { overlayCodexRoseBridge } from './e2bCodexHarness';
import { workDirForGithubRepo } from './e2bWorkDir';
import { createSandboxWithRetry } from './e2bSandboxCreate';
import {
  fileHash,
  findLocalClaudeCodeWsServer,
  findLocalCodexCodeWsServer,
  overlayClaudeCodeWsServer,
  overlayCodexCodeWsServer,
} from './e2bWsServerOverlay';
import {
  createLocalClaudeCodeSessionIfBillingBlocked,
  resolveLocalSessionWorkDir,
} from './claudeCodeLocalSession';
import type { ProjectRestoreReport, ProjectWorkspace } from './projects/types';
import { restoreSandboxProject } from './projects/workspace';
import { withClaudeCodeCreateSlot } from './e2bCreateSlot';
import { codeSessionTurnToken } from './codeSessionTurns';
import { applyUserUiSandboxEnvs, writeUserUiWorkspaceToSandboxSafe } from './userUi/workspace';
import { agentToolsForLocalHome } from './agentTools/workspace';
import { prepareCodeSessionWorkspace } from './codeSessionWorkspace';
import {
  isRefreshOnlyOauthEnvelope,
  resolveClaudeCodeAuthEnvs,
  resolveClaudeCodeSandboxApiKey,
  resolveClaudeCodeTokenSource,
  resolveCodexCodeAuthEnvs,
  shouldEnableClaudeCodeFastMode,
  shouldIgnoreAnthropicApiKeyCooldownForSandbox,
  shouldInjectClaudeCodeFastModeProxy,
  shouldPreferSandboxAnthropicBaseUrlOverFastMode,
  shouldSkipSandboxAnthropicGatewayForOauth,
} from './claudeCodeSandboxAuth';
export { createSandboxWithRetry, isTransientSandboxCreateError } from './e2bSandboxCreate';
export {
  closeClaudeCodeSession,
  connectToSandbox,
  getClaudeCodeSession,
  getClaudeCodeSessionBySandboxId,
  parseClaudeCodeUsage,
  type ClaudeCodeUsage,
} from './e2bCloseSession';
export {
  CODE_AGENT_CREDENTIALS_UNAVAILABLE,
  CodeAgentCredentialError,
  isRefreshOnlyOauthEnvelope,
  OPENROUTER_ANTHROPIC_COMPAT_BASE_URL,
  resolveClaudeCodeAuthEnvs,
  resolveClaudeCodeSandboxApiKey,
  resolveClaudeCodeTokenSource,
  resolveCodexCodeAuthEnvs,
  resolveHostAnthropicBaseUrl,
  shouldEnableClaudeCodeFastMode,
  shouldIgnoreAnthropicApiKeyCooldownForSandbox,
  shouldInjectClaudeCodeFastModeProxy,
  shouldPreferSandboxAnthropicBaseUrlOverFastMode,
  shouldSkipSandboxAnthropicGatewayForOauth,
} from './claudeCodeSandboxAuth';

const log = createLogger('E2B');

// Validate required environment variables
if (!process.env.E2B_API_KEY) {
  log.warn('E2B_API_KEY environment variable not set - Claude Code sessions disabled');
}

if (!process.env.E2B_CLAUDE_CODE_TEMPLATE_ID) {
  log.warn(
    'E2B_CLAUDE_CODE_TEMPLATE_ID environment variable not set - Claude Code sessions disabled'
  );
}

const WS_PORT = 3000;
const SANDBOX_TIMEOUT_MS = 1800000; // 30 minutes (matches agents MAX_RUNTIME_S)
const WS_READY_TIMEOUT_MS = 10000;
const CODEX_WS_READY_TIMEOUT_MS = 30000;
const WS_READY_POLL_INTERVAL_MS = 100;
const DEFAULT_CODEX_CODE_TEMPLATE_ID = 'codex-code';

/**
 * Create a new E2B sandbox with Claude Code and WebSocket streaming.
 *
 * @param agentId - The agent creating this session
 * @param goal - The goal for Claude Code to accomplish
 * @param attachments - Optional file attachments to upload to sandbox
 * @param githubRepoUrl - Optional GitHub repo URL to clone before starting Claude
 * @returns Session info including WebSocket URL for terminal streaming
 */
export interface ClaudeCodeSessionOptions {
  /** Project restored into `~/workspace` before the CLI starts (PJ3 / C9). */
  projectWorkspace?: ProjectWorkspace | null;
}

export async function createClaudeCodeSession(
  agentId: string,
  goal: string,
  attachments?: FilePointer[],
  githubRepoUrl?: string,
  userId?: string,
  fastModeCacheEnabled?: boolean,
  options: ClaudeCodeSessionOptions = {}
): Promise<{
  wsUrl: string;
  taskId: string;
  sandboxId: string;
  uploadedFiles: string[];
  projectRestore?: ProjectRestoreReport | null;
}> {
  // Serialize creates — concurrent reserve-script calls stampede E2B redis.
  return withClaudeCodeCreateSlot(() =>
    createClaudeCodeSessionUnlocked(
      agentId,
      goal,
      attachments,
      githubRepoUrl,
      userId,
      fastModeCacheEnabled,
      options
    )
  );
}

async function createClaudeCodeSessionUnlocked(
  agentId: string,
  goal: string,
  attachments?: FilePointer[],
  githubRepoUrl?: string,
  userId?: string,
  fastModeCacheEnabled?: boolean,
  options: ClaudeCodeSessionOptions = {}
): Promise<{
  wsUrl: string;
  taskId: string;
  sandboxId: string;
  uploadedFiles: string[];
  projectRestore?: ProjectRestoreReport | null;
}> {
  const projectWorkspace = options.projectWorkspace ?? null;
  log.info(`Creating Claude Code session for agent ${agentId}`);

  if (!process.env.E2B_API_KEY || !process.env.E2B_CLAUDE_CODE_TEMPLATE_ID) {
    throw new Error('E2B environment variables not configured');
  }

  const taskId = uuidv4();
  const fastModeWriteEnabled = resolveFastModeWriteEnabled(fastModeCacheEnabled, userId);
  const codeAgentFastModeActive = shouldEnableClaudeCodeFastMode({
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    fastModeCacheEnabled,
    fastModeWriteEnabled,
  });
  if (
    !codeAgentFastModeActive &&
    (fastModeCacheEnabled === true || fastModeWriteEnabled) &&
    process.env.OPENROUTER_API_KEY?.trim()
  ) {
    log.info('OpenRouter configured — skipping Fast Mode tee-proxy/flags for Claude Code session');
  }
  const model = process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-5';
  const workDir = workDirForGithubRepo(githubRepoUrl);
  const templateId = process.env.E2B_CLAUDE_CODE_TEMPLATE_ID;
  const runtimeFingerprint = [
    `template:${templateId}`,
    `wrapper:${fileHash(findLocalClaudeCodeWsServer())}`,
    `env:${process.env.FAST_MODE_CODE_AGENT_ENV_FINGERPRINT ?? 'default'}`,
  ].join('|');
  const systemPrompt = withAgentGraphInstructions(
    buildCodeAgentSystemPrompt({
      githubRepoUrl,
      workDir,
    })
  );

  // Build environment variables for sandbox
  const envs: Record<string, string> = {
    CLAUDE_CODE_GOAL: goal,
    CLAUDE_CODE_MODEL: model,
    CODE_AGENT_SYSTEM_PROMPT: systemPrompt,
    // Write capability for direct-chat user turns (codeSessionTurns.ts). The
    // ws URL the browser reads stays read-only without it.
    ...(process.env.BACKEND_API_KEY
      ? { CODE_SESSION_TURN_TOKEN: codeSessionTurnToken(taskId) }
      : {}),
  };

  // Try user's own credentials first, then rotate through the pool. The agent's
  // outer loop already rotates through pool tokens when Anthropic returns 429;
  // we mirror that here so the inner CLI doesn't keep replaying a known-
  // exhausted token.
  let credentialMeta: ClaudeCodeCredentialResult | null = null;
  if (userId) {
    credentialMeta = await fetchClaudeCodeCredentialsWithMeta(userId);
  }

  const sharedAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  // Peek shared cooldown once: drives both OpenRouter auto-fallback and whether
  // a refresh-only OAuth envelope may be skipped.
  const sharedKeyOnCooldown = sharedAnthropicApiKey ? await isAnthropicApiKeyOnCooldown() : false;
  // When Fast Mode is active, prefer OpenRouter over the tee-proxy even if the
  // shared Anthropic key is not on cooldown — fleet guests rarely set
  // ANTHROPIC_BASE_URL, and Fast Mode + Anthropic upstream 403s Claude Code.
  const sandboxTransport = resolveClaudeCodeSandboxApiKey(
    process.env.CLAUDE_CODE_ANTHROPIC_API_KEY,
    sharedAnthropicApiKey,
    {
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      openrouterApiKey: process.env.OPENROUTER_API_KEY,
      sharedKeyOnCooldown,
      preferOpenRouterGateway: codeAgentFastModeActive,
    }
  );
  const sandboxApiKey = sandboxTransport.apiKey;

  // Attachment fingerprints keep Fast Mode traces distinct across H-02 eras
  // (corrupted 369851-byte UTF-8 uploads vs intact 207364-byte JPEGs).
  const attachmentFingerprint =
    attachments && attachments.length > 0
      ? attachments
          .map((fp) => `${fp.original_filename}:${fp.size_bytes}:${fp.storage_path}`)
          .sort()
          .join('|')
      : '';

  // Fast Mode tee-proxy vs funded gateway: resolve transport first. OpenRouter
  // (or any non-api.anthropic.com base) must not be overwritten by Fast Mode —
  // the proxy forwards to api.anthropic.com and 403s gateway keys.
  const preferSandboxBase = shouldPreferSandboxAnthropicBaseUrlOverFastMode(
    sandboxTransport.baseUrl
  );
  // Fast Mode CLI flags + tee-proxy only when opt-in Fast Mode is active and we
  // are not already on a funded non-Anthropic gateway. Andy write-through alone
  // must not inject the proxy (k=5 t5 recurrence, 2026-08-21).
  const injectFastModeProxy = shouldInjectClaudeCodeFastModeProxy({
    codeAgentFastModeActive,
    preferSandboxBase,
  });
  if (injectFastModeProxy) {
    envs.CLAUDE_CODE_FAST_MODE = '1';
    envs.CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS = '1';
    envs.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK = '1';
  }
  const fastModeEnv: Record<string, string> = injectFastModeProxy
    ? buildFastModeAnthropicEnv(
        goal,
        fastModeCacheEnabled === true,
        process.env.FAST_MODE_ANTHROPIC_PROXY_URL,
        fastModeWriteEnabled,
        {
          sessionId: taskId,
          trace: {
            goal,
            systemPrompt,
            model,
            codeProvider: 'claude',
            templateId,
            runtimeFingerprint: attachmentFingerprint
              ? `${runtimeFingerprint}|att:${attachmentFingerprint}`
              : runtimeFingerprint,
            workDir,
            githubRepoUrl,
          },
        }
      )
    : {};
  const sandboxBaseUrlCandidate = sandboxTransport.baseUrl;
  const ignoreSharedCooldown = shouldIgnoreAnthropicApiKeyCooldownForSandbox({
    sandboxApiKey,
    sharedAnthropicApiKey,
    sandboxBaseUrl: sandboxBaseUrlCandidate,
  });
  // A refreshable OAuth envelope after direct-token auth_error must not block the
  // funded API-key path when the envelope's refresh_token is also dead
  // (invalid_grant): Claude Code would 401 in-sandbox instead of using the key.
  // Resolve this BEFORE choosing ANTHROPIC_BASE_URL so a nulled envelope can
  // still take the OpenRouter gateway, while a live oauth_token never does.
  if (credentialMeta && isRefreshOnlyOauthEnvelope(credentialMeta) && sandboxApiKey) {
    // Dedicated gateway keys / ANTHROPIC_BASE_URL overrides are never gated by
    // the shared Anthropic-org cooldown (that cooldown tracks api.anthropic.com).
    const envelopeBlockedBySharedCooldown = !ignoreSharedCooldown && sharedKeyOnCooldown;
    if (!envelopeBlockedBySharedCooldown) {
      log.info(
        `Preferring sandbox Anthropic API key over refresh-only OAuth envelope for agent ${agentId}`
      );
      credentialMeta = null;
    }
  }

  // OAuth sessions must hit api.anthropic.com. OpenRouter + oauth_token produced
  // "401 Missing Authentication header" on Pre-Deploy claude-code-agent (2026-08-21).
  const skipGatewayForOauth = shouldSkipSandboxAnthropicGatewayForOauth(credentialMeta);
  if (skipGatewayForOauth) {
    log.info(
      `Using Claude OAuth for agent ${agentId} — Anthropic default host (sandbox gateway base skipped)`
    );
  } else if (preferSandboxBase && sandboxTransport.baseUrl) {
    envs.ANTHROPIC_BASE_URL = sandboxTransport.baseUrl;
    log.info(
      `Routing sandbox Anthropic calls via funded gateway ${envs.ANTHROPIC_BASE_URL} (Fast Mode proxy skipped)`
    );
  } else if (fastModeEnv.ANTHROPIC_BASE_URL !== undefined) {
    envs.ANTHROPIC_BASE_URL = fastModeEnv.ANTHROPIC_BASE_URL;
    log.info(`Fast Mode: routing sandbox Anthropic calls via ${envs.ANTHROPIC_BASE_URL}`);
  } else if (sandboxTransport.baseUrl) {
    envs.ANTHROPIC_BASE_URL = sandboxTransport.baseUrl;
    log.info(`Routing sandbox Anthropic calls via ${envs.ANTHROPIC_BASE_URL}`);
  } else if (fastModeWriteEnabled) {
    log.warn(
      'Fast Mode cache active but FAST_MODE_ANTHROPIC_PROXY_URL unset — code agent not cached'
    );
  }
  // Only consult the shared Anthropic-org cooldown when the sandbox would use
  // that same shared key against api.anthropic.com.
  const apiKeyOnCooldown =
    !credentialMeta && sandboxApiKey && !ignoreSharedCooldown ? sharedKeyOnCooldown : false;
  Object.assign(envs, resolveClaudeCodeAuthEnvs(credentialMeta, sandboxApiKey, apiKeyOnCooldown));
  const claudeTokenSource = resolveClaudeCodeTokenSource(credentialMeta);

  if (credentialMeta) {
    log.info(
      `Using ${credentialMeta.source} Claude Code credentials for agent ${agentId} (integration ${credentialMeta.poolTokenId ?? 'user-owned'}, mode ${credentialMeta.credentialMode})`
    );
  } else {
    log.info(
      `Using ${ignoreSharedCooldown ? 'dedicated Claude Code' : 'ANTHROPIC_API_KEY'} funded fallback for agent ${agentId}`
    );
  }

  // Add GitHub config if repo specified
  if (githubRepoUrl) {
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN not configured - cannot clone repositories');
    }
    envs.GITHUB_REPO_URL = githubRepoUrl;
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    log.info(`GitHub repo configured: ${githubRepoUrl}`);
  }

  const userUiWorkspace = await prepareCodeSessionWorkspace(userId, agentId, taskId, 'claude');
  applyUserUiSandboxEnvs(envs, userUiWorkspace);

  // Create sandbox first (before DB record) to avoid placeholder conflicts.
  // When E2B team billing blocks creates, fall back to a same-host local
  // Claude Code ws-server so code-agent benches can still make progress.
  let sandbox;
  try {
    sandbox = await createSandboxWithRetry(
      process.env.E2B_CLAUDE_CODE_TEMPLATE_ID,
      {
        apiKey: process.env.E2B_API_KEY,
        timeoutMs: SANDBOX_TIMEOUT_MS,
        envs,
      },
      'Claude Code'
    );
  } catch (err) {
    const local = await createLocalClaudeCodeSessionIfBillingBlocked(err, {
      taskId,
      agentId,
      goal,
      envs,
      attachments,
      // Same-host session: loopback tools URL, MCP path under the local HOME.
      userUiWorkspace: agentToolsForLocalHome(userUiWorkspace, resolveLocalSessionWorkDir(taskId)),
      projectWorkspace,
      claudeTokenSource,
      claudeTokenIntegrationId:
        credentialMeta?.source === 'pool' ? (credentialMeta.poolTokenId ?? null) : null,
    });
    if (local) return local;
    throw err;
  }

  log.info(`Created sandbox: ${sandbox.sandboxId}`);
  await overlayClaudeCodeWsServer(sandbox);
  await writeUserUiWorkspaceToSandboxSafe(sandbox, userUiWorkspace, agentId);
  const project = await restoreSandboxProject(taskId, sandbox, projectWorkspace);

  const uploadedFiles = await uploadAttachmentsToSandbox(sandbox, attachments, 'Claude Code');

  // Get WebSocket URL for the frontend to connect to
  const wsHost = sandbox.getHost(WS_PORT);
  const wsUrl = `wss://${wsHost}`;

  // Start the WebSocket server (runs Claude Code internally)
  // timeoutMs: 0 = no timeout (default is 60s which was killing the process!)
  sandbox.commands
    .run('node /home/user/ws-server.mjs', {
      background: true,
      timeoutMs: 0,
      ...(project.envs ? { envs: project.envs } : {}),
    })
    .catch((err) =>
      log.error('Failed to start WS server', {
        error: err instanceof Error ? err.message : String(err),
      })
    );

  // Wait for WS server to be ready
  log.info('Waiting for WebSocket server to start');
  const startTime = Date.now();
  let wsReady = false;

  // eslint-disable-next-line no-restricted-syntax -- polling loop (wait-until-ready), not a retry-on-error pattern
  while (Date.now() - startTime < WS_READY_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, WS_READY_POLL_INTERVAL_MS));
    try {
      // Check if port 3000 is listening
      const result = await sandbox.commands.run(`netstat -tln | grep :${WS_PORT}`, {
        timeoutMs: 2000,
      });
      if (result.exitCode === 0 && result.stdout.includes(`:${WS_PORT}`)) {
        const elapsedMs = Date.now() - startTime;
        log.info(`WebSocket server ready in ${elapsedMs}ms`);
        wsReady = true;
        break;
      }
    } catch {
      // Ignore errors, just retry
    }
  }

  const totalElapsed = Date.now() - startTime;
  if (!wsReady) {
    log.warn(`WebSocket server readiness check timed out after ${totalElapsed}ms`);
    await sandbox.kill();
    throw new Error('Claude Code WebSocket server failed to become ready');
  }

  // Create DB record with real values (no placeholders)
  await prisma.claudeCodeSession.create({
    data: {
      id: taskId,
      agentId,
      sandboxId: sandbox.sandboxId,
      streamUrl: wsUrl,
      goal,
      status: 'ACTIVE',
      claudeTokenSource,
      claudeTokenIntegrationId:
        credentialMeta?.source === 'pool' ? (credentialMeta.poolTokenId ?? null) : null,
      projectId: projectWorkspace?.project.id ?? null,
    },
  });

  log.info(`Session ready: ${taskId}, WS: ${wsUrl}`);

  return {
    wsUrl,
    taskId,
    sandboxId: sandbox.sandboxId,
    uploadedFiles,
    projectRestore: project.report,
  };
}

export async function createCodexCodeSession(
  agentId: string,
  goal: string,
  attachments?: FilePointer[],
  githubRepoUrl?: string,
  userId?: string,
  fastModeCacheEnabled?: boolean,
  harnessOptions?: {
    harnessMode?: 'code' | 'rose';
    roseApiBaseUrl?: string;
    memoryEnabled?: boolean;
  }
): Promise<{ wsUrl: string; taskId: string; sandboxId: string; uploadedFiles: string[] }> {
  log.info(`Creating Codex Code session for agent ${agentId}`);

  if (!process.env.E2B_API_KEY) {
    throw new Error('E2B Codex environment variables not configured');
  }
  if (!userId) {
    throw new Error('user_id is required to create a Codex Code session');
  }

  const taskId = uuidv4();
  const templateId = process.env.E2B_CODEX_CODE_TEMPLATE_ID || DEFAULT_CODEX_CODE_TEMPLATE_ID;
  const model = process.env.CODEX_CODE_MODEL || 'gpt-5.6-terra';
  const harnessMode = harnessOptions?.harnessMode ?? 'code';
  const roseApiBaseUrl = harnessOptions?.roseApiBaseUrl?.replace(/\/$/, '');
  const workDir = workDirForGithubRepo(githubRepoUrl);
  const runtimeFingerprint = [
    `template:${templateId}`,
    `wrapper:${fileHash(findLocalCodexCodeWsServer())}`,
    `env:${process.env.FAST_MODE_CODE_AGENT_ENV_FINGERPRINT ?? 'default'}`,
  ].join('|');
  const systemPrompt =
    harnessMode === 'rose' && roseApiBaseUrl
      ? buildCodexHarnessSystemPrompt({
          roseApiBaseUrl,
          roseUserId: userId,
          anchorAgentId: agentId,
        })
      : withAgentGraphInstructions(
          buildCodeAgentSystemPrompt({
            githubRepoUrl,
            workDir,
          })
        );

  const credentialMeta: GptCodeCredentialEnvelopeResult | null =
    await fetchGptCodeCredentialsWithMeta(userId);
  // No OAuth credential (or every pool token is rate-limited → filtered to
  // null) falls back to the funded OpenAI API key, mirroring the Claude Code
  // path and the Rose completions fallback. GPT_API_KEY is the same funded key
  // the in-process Rose client uses when compute tokens are exhausted.
  const fundedKeyConfigured =
    process.env.GPT_API_KEY !== undefined && process.env.GPT_API_KEY !== '';
  const fundedKeyOnCooldown = fundedKeyConfigured ? await isGptApiKeyOnCooldown() : false;
  const authEnvs = resolveCodexCodeAuthEnvs(
    credentialMeta,
    process.env.GPT_API_KEY,
    fundedKeyOnCooldown
  );

  const envs: Record<string, string> = {
    CODEX_GOAL: goal,
    ...authEnvs,
    CODEX_MODEL: model,
    CODE_AGENT_SYSTEM_PROMPT: systemPrompt,
    CODE_AGENT_HARNESS_MODE: harnessMode,
    // Write capability for inbound turns (agent-graph messages, direct chat);
    // same per-task token as the Claude Code session.
    ...(process.env.BACKEND_API_KEY
      ? { CODE_SESSION_TURN_TOKEN: codeSessionTurnToken(taskId) }
      : {}),
  };
  if (harnessMode === 'rose' && roseApiBaseUrl) {
    const apiKey = process.env.BACKEND_API_KEY ?? '';
    if (!apiKey) {
      throw new Error('BACKEND_API_KEY is required for Codex rose harness sessions');
    }
    envs.ROSE_API_BASE_URL = roseApiBaseUrl;
    envs.ROSE_API_KEY = apiKey;
    envs.ROSE_USER_ID = userId!;
    envs.ROSE_ANCHOR_AGENT_ID = agentId;
    // Benchmark runs are memory-off unless their catalog task explicitly opts
    // into the planner-memory A/B arm.
    envs.ROSE_MEMORY_ENABLED = harnessOptions?.memoryEnabled === true ? 'true' : 'false';
  }
  if (credentialMeta) {
    log.info(`Using ${credentialMeta.source} GPT Code credentials for agent ${agentId}`);
  } else {
    log.info(`Using OPENAI_API_KEY funded fallback for Codex Code agent ${agentId}`);
  }

  const fastModeWriteEnabled = resolveFastModeWriteEnabled(fastModeCacheEnabled, userId);
  const fastModeEnv = buildFastModeCodexEnv(
    goal,
    fastModeCacheEnabled === true,
    undefined,
    fastModeWriteEnabled,
    {
      sessionId: taskId,
      trace: {
        goal,
        systemPrompt,
        model,
        codeProvider: 'codex',
        templateId,
        runtimeFingerprint,
        workDir,
        githubRepoUrl,
      },
    }
  );
  log.info('Fast Mode: Codex code-agent cache config', {
    agentId,
    taskId,
    fastModeCacheEnabled: fastModeCacheEnabled === true,
    fastModeWriteEnabled,
    hasCodexProxyUrl: Boolean(process.env.FAST_MODE_CODEX_PROXY_URL),
    hasAnthropicProxyUrl: Boolean(process.env.FAST_MODE_ANTHROPIC_PROXY_URL),
    proxyInjected: fastModeEnv.CODEX_FAST_MODE_PROXY_URL !== undefined,
  });
  if (fastModeEnv.CODEX_FAST_MODE_PROXY_URL !== undefined) {
    envs.CODEX_FAST_MODE_PROXY_URL = fastModeEnv.CODEX_FAST_MODE_PROXY_URL;
    log.info(`Fast Mode: routing sandbox Codex calls via ${envs.CODEX_FAST_MODE_PROXY_URL}`);
  } else if (fastModeCacheEnabled === true) {
    throw new Error(
      'Fast Mode cache is enabled for Codex code agent but no Codex proxy URL is configured. ' +
        'Set FAST_MODE_CODEX_PROXY_URL or FAST_MODE_ANTHROPIC_PROXY_URL ending in /anthropic-proxy.'
    );
  } else if (fastModeWriteEnabled) {
    log.warn(
      'Fast Mode cache active but FAST_MODE_CODEX_PROXY_URL unset — Codex code agent not cached'
    );
  }

  if (githubRepoUrl) {
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN not configured - cannot clone repositories');
    }
    envs.GITHUB_REPO_URL = githubRepoUrl;
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    log.info(`GitHub repo configured for Codex: ${githubRepoUrl}`);
  }

  const userUiWorkspace = await prepareCodeSessionWorkspace(userId, agentId, taskId, 'codex');
  applyUserUiSandboxEnvs(envs, userUiWorkspace);

  const sandbox = await createSandboxWithRetry(
    templateId,
    {
      apiKey: process.env.E2B_API_KEY,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      envs,
    },
    'Codex Code'
  );

  log.info(`Created Codex sandbox: ${sandbox.sandboxId}`);
  await overlayCodexCodeWsServer(sandbox);
  if (harnessMode === 'rose') {
    await overlayCodexRoseBridge(sandbox);
  }
  await writeUserUiWorkspaceToSandboxSafe(sandbox, userUiWorkspace, agentId);

  const uploadedFiles = await uploadAttachmentsToSandbox(sandbox, attachments, 'Codex');

  const wsHost = sandbox.getHost(WS_PORT);
  const wsUrl = `wss://${wsHost}`;

  sandbox.commands
    .run('node /home/user/ws-server.mjs', {
      background: true,
      timeoutMs: 0,
    })
    .catch((err) =>
      log.error('Failed to start Codex WS server', {
        error: err instanceof Error ? err.message : String(err),
      })
    );

  log.info('Waiting for Codex WebSocket server to start');
  const startTime = Date.now();
  let wsReady = false;
  // eslint-disable-next-line no-restricted-syntax -- polling loop (wait-until-ready), not retry fallback
  while (Date.now() - startTime < CODEX_WS_READY_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, WS_READY_POLL_INTERVAL_MS));
    try {
      const result = await sandbox.commands.run(`netstat -tln | grep :${WS_PORT}`, {
        timeoutMs: 2000,
      });
      if (result.exitCode === 0 && result.stdout.includes(`:${WS_PORT}`)) {
        log.info(`Codex WebSocket server ready in ${Date.now() - startTime}ms`);
        wsReady = true;
        break;
      }
    } catch {
      // Ignore readiness probe failures until timeout.
    }
  }

  if (!wsReady) {
    log.warn(`Codex WebSocket server readiness check timed out after ${Date.now() - startTime}ms`);
    await sandbox.kill();
    throw new Error('Codex WebSocket server failed to become ready');
  }

  await prisma.claudeCodeSession.create({
    data: {
      id: taskId,
      agentId,
      sandboxId: sandbox.sandboxId,
      streamUrl: wsUrl,
      goal,
      status: 'ACTIVE',
      claudeTokenSource: credentialMeta?.source ?? null,
      claudeTokenIntegrationId:
        credentialMeta?.integrationId ?? credentialMeta?.poolTokenId ?? null,
    },
  });

  log.info(`Codex session ready: ${taskId}, WS: ${wsUrl}`);

  return {
    wsUrl,
    taskId,
    sandboxId: sandbox.sandboxId,
    uploadedFiles,
  };
}
