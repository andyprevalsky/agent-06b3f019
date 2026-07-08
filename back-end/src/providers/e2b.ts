import { Sandbox } from 'e2b';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from './database';
import { createLogger } from './logger';
import {
  buildFastModeAnthropicEnv,
  buildFastModeCodexEnv,
  shouldWriteFastModeCacheForUser,
} from './codeAgentFastModeEnv';
import { FilePointer, downloadFromStorage } from './storage';
import { v4 as uuidv4 } from 'uuid';
import {
  fetchClaudeCodeCredentialsWithMeta,
  type ClaudeCodeCredentialResult,
} from './claudeCredentials';
import { isAnthropicApiKeyOnCooldown } from './computeCredentials';
import {
  fetchGptCodeCredentialsWithMeta,
  type GptCodeCredentialEnvelopeResult,
} from './gptCredentials';
import {
  buildCodeAgentSystemPrompt,
  CODE_AGENT_ATTACHMENTS_DIR,
  CODE_AGENT_OUTPUT_DIR,
} from './codeAgentPrompt';
export {
  closeClaudeCodeSession,
  connectToSandbox,
  getClaudeCodeSession,
  getClaudeCodeSessionBySandboxId,
  parseClaudeCodeUsage,
  type ClaudeCodeUsage,
} from './e2bCloseSession';

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
const SANDBOX_TIMEOUT_MS = 1800000; // 30 minutes
const WS_READY_TIMEOUT_MS = 10000;
const CODEX_WS_READY_TIMEOUT_MS = 30000;
const WS_READY_POLL_INTERVAL_MS = 100;
const DEFAULT_CODEX_CODE_TEMPLATE_ID = 'codex-code';

// Directories for file transfer
const ATTACHMENTS_DIR = CODE_AGENT_ATTACHMENTS_DIR;
const OUTPUT_DIR = CODE_AGENT_OUTPUT_DIR;
const CLAUDE_CODE_WS_SERVER_PATH = '/home/user/ws-server.mjs';
const CODE_AGENT_REPO_WORKDIR = '/home/user/workspace';

function workDirForGithubRepo(githubRepoUrl?: string): string {
  if (!githubRepoUrl) return '/home/user';
  try {
    new URL(githubRepoUrl);
    return CODE_AGENT_REPO_WORKDIR;
  } catch {
    return '/home/user';
  }
}

function findLocalClaudeCodeWsServer(): string | null {
  const candidates = [
    join(process.cwd(), '..', 'e2b-templates', 'claude-code', 'ws-server.mjs'),
    join(process.cwd(), 'e2b-templates', 'claude-code', 'ws-server.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function findLocalCodexCodeWsServer(): string | null {
  const candidates = [
    join(process.cwd(), '..', 'e2b-templates', 'codex-code', 'ws-server.mjs'),
    join(process.cwd(), 'e2b-templates', 'codex-code', 'ws-server.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function fileHash(path: string | null): string {
  if (path === null || !existsSync(path)) return 'bundled';
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

async function overlayClaudeCodeWsServer(
  sandbox: Awaited<ReturnType<typeof Sandbox.create>>
): Promise<void> {
  const serverPath = findLocalClaudeCodeWsServer();
  if (serverPath === null) {
    log.warn('Claude Code ws-server overlay not found; using server bundled in E2B template');
    return;
  }

  const content = readFileSync(serverPath);
  await sandbox.files.write(CLAUDE_CODE_WS_SERVER_PATH, new Blob([content]));
  await sandbox.commands.run(
    `chmod +x ${CLAUDE_CODE_WS_SERVER_PATH} && chown 1000:1000 ${CLAUDE_CODE_WS_SERVER_PATH}`,
    { timeoutMs: 10000 }
  );
  log.info(`Overlayed Claude Code ws-server from ${serverPath}`);
}

async function overlayCodexCodeWsServer(
  sandbox: Awaited<ReturnType<typeof Sandbox.create>>
): Promise<void> {
  const serverPath = findLocalCodexCodeWsServer();
  if (serverPath === null) {
    log.warn('Codex Code ws-server overlay not found; using server bundled in E2B template');
    return;
  }

  const content = readFileSync(serverPath);
  await sandbox.files.write(CLAUDE_CODE_WS_SERVER_PATH, new Blob([content]));
  await sandbox.commands.run(
    `chmod +x ${CLAUDE_CODE_WS_SERVER_PATH} && chown 1000:1000 ${CLAUDE_CODE_WS_SERVER_PATH}`,
    { timeoutMs: 10000 }
  );
  log.info(`Overlayed Codex Code ws-server from ${serverPath}`);
}

/**
 * Create a new E2B sandbox with Claude Code and WebSocket streaming.
 *
 * @param agentId - The agent creating this session
 * @param goal - The goal for Claude Code to accomplish
 * @param attachments - Optional file attachments to upload to sandbox
 * @param githubRepoUrl - Optional GitHub repo URL to clone before starting Claude
 * @returns Session info including WebSocket URL for terminal streaming
 */
/**
 * Decide which auth env vars the Claude Code CLI sandbox should receive.
 *
 * Preference order (mirrors the Rose completions fallback so the code agent
 * stays usable everywhere an OAuth token would be):
 *   1. A synced/pool Claude OAuth credential → CLAUDE_CODE_CREDENTIALS (+ token).
 *   2. The funded ANTHROPIC_API_KEY (billed) — Claude Code CLI reads it natively
 *      — when no OAuth credential is available and the shared key isn't on its
 *      out-of-credits cooldown.
 *   3. Otherwise throw — nothing usable.
 *
 * Pure + exported so the selection is unit-testable without spinning an E2B
 * sandbox (the real session path isn't otherwise reachable in tests).
 */
export function resolveClaudeCodeAuthEnvs(
  credentialMeta: ClaudeCodeCredentialResult | null,
  anthropicApiKey: string | undefined,
  anthropicApiKeyOnCooldown: boolean
): Record<string, string> {
  const envs: Record<string, string> = {};
  if (credentialMeta) {
    if (credentialMeta.credentials) {
      envs.CLAUDE_CODE_CREDENTIALS = credentialMeta.credentials;
    }
    if (credentialMeta.accessToken) {
      envs.CLAUDE_CODE_OAUTH_TOKEN = credentialMeta.accessToken;
    }
    return envs;
  }
  if (anthropicApiKey && !anthropicApiKeyOnCooldown) {
    envs.ANTHROPIC_API_KEY = anthropicApiKey;
    return envs;
  }
  throw new Error(
    'No Claude Code credentials available: no synced user credentials, no available pool tokens, ' +
      'and no usable ANTHROPIC_API_KEY fallback (unset or on cooldown)'
  );
}

export async function createClaudeCodeSession(
  agentId: string,
  goal: string,
  attachments?: FilePointer[],
  githubRepoUrl?: string,
  userId?: string,
  fastModeCacheEnabled?: boolean
): Promise<{ wsUrl: string; taskId: string; sandboxId: string; uploadedFiles: string[] }> {
  log.info(`Creating Claude Code session for agent ${agentId}`);

  if (!process.env.E2B_API_KEY || !process.env.E2B_CLAUDE_CODE_TEMPLATE_ID) {
    throw new Error('E2B environment variables not configured');
  }

  const taskId = uuidv4();
  const fastModeWriteEnabled =
    fastModeCacheEnabled === true || shouldWriteFastModeCacheForUser(userId);
  const codeAgentFastModeActive = fastModeCacheEnabled === true || fastModeWriteEnabled;
  const model = process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-5';
  const workDir = workDirForGithubRepo(githubRepoUrl);
  const templateId = process.env.E2B_CLAUDE_CODE_TEMPLATE_ID;
  const runtimeFingerprint = [
    `template:${templateId}`,
    `wrapper:${fileHash(findLocalClaudeCodeWsServer())}`,
    `env:${process.env.FAST_MODE_CODE_AGENT_ENV_FINGERPRINT ?? 'default'}`,
  ].join('|');
  const systemPrompt = buildCodeAgentSystemPrompt({
    githubRepoUrl,
    workDir,
  });

  // Build environment variables for sandbox
  const envs: Record<string, string> = {
    CLAUDE_CODE_GOAL: goal,
    CLAUDE_CODE_MODEL: model,
    CODE_AGENT_SYSTEM_PROMPT: systemPrompt,
  };
  if (codeAgentFastModeActive) {
    envs.CLAUDE_CODE_FAST_MODE = '1';
    envs.CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS = '1';
    envs.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK = '1';
  }

  // Fast Mode: route the sandbox's Anthropic calls through our tee-proxy so they
  // record/replay. The CLI's Anthropic SDK honors ANTHROPIC_BASE_URL. Only injected
  // when Fast Mode is on AND a proxy URL is configured (else direct to Anthropic).
  const fastModeEnv = buildFastModeAnthropicEnv(
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
        runtimeFingerprint,
        workDir,
        githubRepoUrl,
      },
    }
  );
  if (fastModeEnv.ANTHROPIC_BASE_URL !== undefined) {
    envs.ANTHROPIC_BASE_URL = fastModeEnv.ANTHROPIC_BASE_URL;
    log.info(`Fast Mode: routing sandbox Anthropic calls via ${envs.ANTHROPIC_BASE_URL}`);
  } else if (fastModeWriteEnabled) {
    log.warn(
      'Fast Mode cache active but FAST_MODE_ANTHROPIC_PROXY_URL unset — code agent not cached'
    );
  }

  // Try user's own credentials first, then rotate through the pool. The agent's
  // outer loop already rotates through pool tokens when Anthropic returns 429;
  // we mirror that here so the inner CLI doesn't keep replaying a known-
  // exhausted token.
  let credentialMeta: ClaudeCodeCredentialResult | null = null;
  if (userId) {
    credentialMeta = await fetchClaudeCodeCredentialsWithMeta(userId);
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  // Only consult the shared cooldown when we'd actually need the fallback.
  const apiKeyOnCooldown =
    !credentialMeta && anthropicApiKey ? await isAnthropicApiKeyOnCooldown() : false;
  Object.assign(envs, resolveClaudeCodeAuthEnvs(credentialMeta, anthropicApiKey, apiKeyOnCooldown));

  if (credentialMeta) {
    log.info(
      `Using ${credentialMeta.source} Claude Code credentials for agent ${agentId} (integration ${credentialMeta.poolTokenId ?? 'user-owned'}, mode ${credentialMeta.credentialMode})`
    );
  } else {
    log.info(`Using ANTHROPIC_API_KEY funded fallback for Claude Code agent ${agentId}`);
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

  // Create sandbox first (before DB record) to avoid placeholder conflicts
  const sandbox = await Sandbox.create(process.env.E2B_CLAUDE_CODE_TEMPLATE_ID, {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    envs,
  });

  log.info(`Created sandbox: ${sandbox.sandboxId}`);
  await overlayClaudeCodeWsServer(sandbox);

  // Upload attachments to sandbox if provided
  const uploadedFiles: string[] = [];
  if (attachments && attachments.length > 0) {
    log.info(`Uploading ${attachments.length} attachments to sandbox`);

    // Create attachments and output directories
    await sandbox.commands.run(`mkdir -p ${ATTACHMENTS_DIR} ${OUTPUT_DIR}`);

    for (const fp of attachments) {
      try {
        // Get file content - all files stored in storage
        const content = await downloadFromStorage(fp.storage_path);

        // Write to sandbox (convert Buffer to Blob for E2B API)
        const remotePath = `${ATTACHMENTS_DIR}/${fp.original_filename}`;
        const blob = new Blob([content]);
        await sandbox.files.write(remotePath, blob);
        uploadedFiles.push(remotePath);
        log.info(`Uploaded: ${fp.original_filename} (${content.length} bytes)`);
      } catch (err) {
        log.error(`Failed to upload ${fp.original_filename}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info(`Uploaded ${uploadedFiles.length}/${attachments.length} files`);
  }

  // Get WebSocket URL for the frontend to connect to
  const wsHost = sandbox.getHost(WS_PORT);
  const wsUrl = `wss://${wsHost}`;

  // Start the WebSocket server (runs Claude Code internally)
  // timeoutMs: 0 = no timeout (default is 60s which was killing the process!)
  sandbox.commands
    .run('node /home/user/ws-server.mjs', {
      background: true,
      timeoutMs: 0,
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
      claudeTokenSource: credentialMeta?.source ?? null,
      claudeTokenIntegrationId:
        credentialMeta?.source === 'pool' ? (credentialMeta.poolTokenId ?? null) : null,
    },
  });

  log.info(`Session ready: ${taskId}, WS: ${wsUrl}`);

  return {
    wsUrl,
    taskId,
    sandboxId: sandbox.sandboxId,
    uploadedFiles,
  };
}

export async function createCodexCodeSession(
  agentId: string,
  goal: string,
  attachments?: FilePointer[],
  githubRepoUrl?: string,
  userId?: string,
  fastModeCacheEnabled?: boolean
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
  const model = process.env.CODEX_CODE_MODEL || 'gpt-5.4';
  const workDir = workDirForGithubRepo(githubRepoUrl);
  const runtimeFingerprint = [
    `template:${templateId}`,
    `wrapper:${fileHash(findLocalCodexCodeWsServer())}`,
    `env:${process.env.FAST_MODE_CODE_AGENT_ENV_FINGERPRINT ?? 'default'}`,
  ].join('|');
  const systemPrompt = buildCodeAgentSystemPrompt({
    githubRepoUrl,
    workDir,
  });

  const credentialMeta: GptCodeCredentialEnvelopeResult | null =
    await fetchGptCodeCredentialsWithMeta(userId);
  if (!credentialMeta) {
    throw new Error(
      'No GPT Code credentials available: no synced user credentials and no available pool tokens'
    );
  }

  const envs: Record<string, string> = {
    CODEX_GOAL: goal,
    CODEX_AUTH_JSON: credentialMeta.credentials,
    CODEX_MODEL: model,
    CODE_AGENT_SYSTEM_PROMPT: systemPrompt,
  };

  const fastModeWriteEnabled =
    fastModeCacheEnabled === true || shouldWriteFastModeCacheForUser(userId);
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

  const sandbox = await Sandbox.create(templateId, {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    envs,
  });

  log.info(`Created Codex sandbox: ${sandbox.sandboxId}`);
  await overlayCodexCodeWsServer(sandbox);

  const uploadedFiles: string[] = [];
  if (attachments && attachments.length > 0) {
    log.info(`Uploading ${attachments.length} attachments to Codex sandbox`);
    await sandbox.commands.run(`mkdir -p ${ATTACHMENTS_DIR} ${OUTPUT_DIR}`);

    for (const fp of attachments) {
      try {
        const content = await downloadFromStorage(fp.storage_path);
        const remotePath = `${ATTACHMENTS_DIR}/${fp.original_filename}`;
        const blob = new Blob([content]);
        await sandbox.files.write(remotePath, blob);
        uploadedFiles.push(remotePath);
        log.info(`Uploaded: ${fp.original_filename} (${content.length} bytes)`);
      } catch (err) {
        log.error(`Failed to upload ${fp.original_filename}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

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
      claudeTokenSource: credentialMeta.source,
      claudeTokenIntegrationId:
        credentialMeta.source === 'pool' ? (credentialMeta.poolTokenId ?? null) : null,
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
