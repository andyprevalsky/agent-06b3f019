import { Sandbox } from 'e2b';
import { prisma } from './database';
import { createLogger } from './logger';
import { FilePointer, uploadToStorage, downloadFromStorage } from './storage';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import {
  fetchClaudeCodeCredentialsWithMeta,
  type ClaudeCodeCredentialResult,
} from './claudeCredentials';
import {
  fetchGptCodeCredentialsWithMeta,
  type GptCodeCredentialEnvelopeResult,
} from './gptCredentials';
import {
  buildCodeAgentSystemPrompt,
  CODE_AGENT_ATTACHMENTS_DIR,
  CODE_AGENT_OUTPUT_DIR,
} from './codeAgentPrompt';

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
const WS_READY_POLL_INTERVAL_MS = 100;
const DEFAULT_CODEX_CODE_TEMPLATE_ID = 'codex-code';

// Directories for file transfer
const ATTACHMENTS_DIR = CODE_AGENT_ATTACHMENTS_DIR;
const OUTPUT_DIR = CODE_AGENT_OUTPUT_DIR;

function workDirForGithubRepo(githubRepoUrl?: string): string {
  if (!githubRepoUrl) return '/home/user';
  try {
    const parsed = new URL(githubRepoUrl);
    const repoName = parsed.pathname.split('/').filter(Boolean).pop()?.replace(/\.git$/, '');
    return repoName ? `/home/user/${repoName}` : '/home/user';
  } catch {
    return '/home/user';
  }
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
export async function createClaudeCodeSession(
  agentId: string,
  goal: string,
  attachments?: FilePointer[],
  githubRepoUrl?: string,
  userId?: string
): Promise<{ wsUrl: string; taskId: string; sandboxId: string; uploadedFiles: string[] }> {
  log.info(`Creating Claude Code session for agent ${agentId}`);

  if (!process.env.E2B_API_KEY || !process.env.E2B_CLAUDE_CODE_TEMPLATE_ID) {
    throw new Error('E2B environment variables not configured');
  }

  // Build environment variables for sandbox
  const envs: Record<string, string> = {
    CLAUDE_CODE_GOAL: goal,
    CODE_AGENT_SYSTEM_PROMPT: buildCodeAgentSystemPrompt({
      githubRepoUrl,
      workDir: workDirForGithubRepo(githubRepoUrl),
    }),
  };

  // Try user's own credentials first, then rotate through the pool. The agent's
  // outer loop already rotates through pool tokens when Anthropic returns 429;
  // we mirror that here so the inner CLI doesn't keep replaying a known-
  // exhausted token.
  let credentialMeta: ClaudeCodeCredentialResult | null = null;
  if (userId) {
    credentialMeta = await fetchClaudeCodeCredentialsWithMeta(userId);
    if (credentialMeta) {
      if (credentialMeta.credentials) {
        envs.CLAUDE_CODE_CREDENTIALS = credentialMeta.credentials;
      }
      if (credentialMeta.credentialMode === 'oauth_token' && credentialMeta.accessToken) {
        envs.CLAUDE_CODE_OAUTH_TOKEN = credentialMeta.accessToken;
      }
      log.info(
        `Using ${credentialMeta.source} Claude Code credentials for agent ${agentId} (integration ${credentialMeta.poolTokenId ?? 'user-owned'}, mode ${credentialMeta.credentialMode})`
      );
    }
  }

  if (!credentialMeta) {
    throw new Error(
      'No Claude Code OAuth credentials available: no synced user credentials and no available pool tokens (all rate-limited, invalid, or none configured)'
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

  // Generate taskId upfront
  const taskId = uuidv4();

  // Create sandbox first (before DB record) to avoid placeholder conflicts
  const sandbox = await Sandbox.create(process.env.E2B_CLAUDE_CODE_TEMPLATE_ID, {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    envs,
  });

  log.info(`Created sandbox: ${sandbox.sandboxId}`);

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
        break;
      }
    } catch {
      // Ignore errors, just retry
    }
  }

  const totalElapsed = Date.now() - startTime;
  if (totalElapsed >= WS_READY_TIMEOUT_MS) {
    log.warn(`WebSocket server readiness check timed out after ${totalElapsed}ms`);
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
  userId?: string
): Promise<{ wsUrl: string; taskId: string; sandboxId: string; uploadedFiles: string[] }> {
  log.info(`Creating Codex Code session for agent ${agentId}`);

  if (!process.env.E2B_API_KEY) {
    throw new Error('E2B Codex environment variables not configured');
  }
  if (!userId) {
    throw new Error('user_id is required to create a Codex Code session');
  }

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
    CODEX_MODEL: process.env.CODEX_CODE_MODEL || 'gpt-5.4',
    CODE_AGENT_SYSTEM_PROMPT: buildCodeAgentSystemPrompt({
      githubRepoUrl,
      workDir: workDirForGithubRepo(githubRepoUrl),
    }),
  };

  if (githubRepoUrl) {
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN not configured - cannot clone repositories');
    }
    envs.GITHUB_REPO_URL = githubRepoUrl;
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    log.info(`GitHub repo configured for Codex: ${githubRepoUrl}`);
  }

  const taskId = uuidv4();
  const templateId = process.env.E2B_CODEX_CODE_TEMPLATE_ID || DEFAULT_CODEX_CODE_TEMPLATE_ID;
  const sandbox = await Sandbox.create(templateId, {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    envs,
  });

  log.info(`Created Codex sandbox: ${sandbox.sandboxId}`);

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
  // eslint-disable-next-line no-restricted-syntax -- polling loop (wait-until-ready), not retry fallback
  while (Date.now() - startTime < WS_READY_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, WS_READY_POLL_INTERVAL_MS));
    try {
      const result = await sandbox.commands.run(`netstat -tln | grep :${WS_PORT}`, {
        timeoutMs: 2000,
      });
      if (result.exitCode === 0 && result.stdout.includes(`:${WS_PORT}`)) {
        log.info(`Codex WebSocket server ready in ${Date.now() - startTime}ms`);
        break;
      }
    } catch {
      // Ignore readiness probe failures until timeout.
    }
  }

  if (Date.now() - startTime >= WS_READY_TIMEOUT_MS) {
    log.warn(`Codex WebSocket server readiness check timed out after ${Date.now() - startTime}ms`);
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

/**
 * Close a Claude Code session and extract output files.
 *
 * @param taskId - Session ID
 * @param userId - User ID for storing output files
 * @param agentId - Agent ID for storing output files
 * @returns Output files created by the agent
 */
// Type for Claude Code usage extracted from JSONL logs
export interface ClaudeCodeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Parse Claude Code JSONL logs to extract token usage.
 * Claude Code logs each message with usage data in ~/.claude/projects/
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numericUsageValue(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function parseClaudeCodeUsage(jsonlContent: string): ClaudeCodeUsage {
  const usage: ClaudeCodeUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  const lines = jsonlContent.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as unknown;
      if (!isJsonObject(entry)) continue;

      const message = isJsonObject(entry.message) ? entry.message : undefined;
      const rawUsage = isJsonObject(entry.usage)
        ? entry.usage
        : message !== undefined && isJsonObject(message.usage)
          ? message.usage
          : undefined;

      if (rawUsage === undefined) continue;

      usage.inputTokens += numericUsageValue(rawUsage, 'input_tokens');
      usage.outputTokens += numericUsageValue(rawUsage, 'output_tokens');
      usage.cacheReadInputTokens += numericUsageValue(rawUsage, 'cache_read_input_tokens');
      usage.cacheCreationInputTokens += numericUsageValue(rawUsage, 'cache_creation_input_tokens');
    } catch {
      // Skip malformed lines
    }
  }

  return usage;
}

export async function closeClaudeCodeSession(
  taskId: string,
  userId?: string,
  agentId?: string,
  additionalPaths?: string[]
): Promise<{ outputFiles: FilePointer[]; usage?: ClaudeCodeUsage }> {
  log.info(`Closing Claude Code session ${taskId}`);

  const session = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
  });

  if (!session) {
    throw new Error(`Claude Code session not found: ${taskId}`);
  }

  const outputFiles: FilePointer[] = [];
  let usage: ClaudeCodeUsage | undefined;

  try {
    // Connect to sandbox
    const sandbox = await Sandbox.connect(session.sandboxId, {
      apiKey: process.env.E2B_API_KEY,
    });

    // Extract Claude Code usage from JSONL logs before killing sandbox
    try {
      // Find the most recent JSONL file in ~/.claude/projects/
      // Claude Code creates project-specific dirs with conversation logs
      const findJsonlResult = await sandbox.commands.run(
        `find /home/user/.claude/projects -name "*.jsonl" -type f 2>/dev/null | head -5`,
        { timeoutMs: 5000 }
      );

      if (findJsonlResult.stdout && findJsonlResult.stdout.trim()) {
        const jsonlFiles = findJsonlResult.stdout.split('\n').filter((f) => f.trim());
        log.info(`Found ${jsonlFiles.length} JSONL files for usage extraction`);

        const totalUsage: ClaudeCodeUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        };

        for (const jsonlFile of jsonlFiles) {
          try {
            const content = await sandbox.files.read(jsonlFile.trim(), { format: 'text' });
            const fileUsage = parseClaudeCodeUsage(content as string);
            totalUsage.inputTokens += fileUsage.inputTokens;
            totalUsage.outputTokens += fileUsage.outputTokens;
            totalUsage.cacheReadInputTokens += fileUsage.cacheReadInputTokens;
            totalUsage.cacheCreationInputTokens += fileUsage.cacheCreationInputTokens;
            log.info(
              `Parsed usage from ${jsonlFile}: in=${fileUsage.inputTokens}, out=${fileUsage.outputTokens}`
            );
          } catch (readErr) {
            log.error(`Failed to read JSONL file ${jsonlFile}`, {
              error: readErr instanceof Error ? readErr.message : String(readErr),
            });
          }
        }

        if (totalUsage.inputTokens > 0 || totalUsage.outputTokens > 0) {
          usage = totalUsage;
          log.info(
            `Total Claude Code usage: in=${usage.inputTokens}, out=${usage.outputTokens}, cache_read=${usage.cacheReadInputTokens}, cache_create=${usage.cacheCreationInputTokens}`
          );
        }
      } else {
        log.info('No JSONL files found for usage extraction');
      }
    } catch (usageErr) {
      log.error('Failed to extract Claude Code usage', {
        error: usageErr instanceof Error ? usageErr.message : String(usageErr),
      });
    }

    // Extract output files if userId and agentId provided
    if (userId && agentId) {
      try {
        // List files in output directory (using find for reliable filename handling)
        const findResult = await sandbox.commands.run(
          `find ${OUTPUT_DIR} -maxdepth 1 -type f -printf '%f\\n' 2>/dev/null || echo "NO_DIR"`,
          { timeoutMs: 5000 }
        );

        if (findResult.stdout && !findResult.stdout.includes('NO_DIR')) {
          const filenames = findResult.stdout.split('\n').filter((name) => name.trim());

          for (const filename of filenames) {
            try {
              const remotePath = `${OUTPUT_DIR}/${filename}`;
              // Read as binary (Uint8Array) to avoid corrupting images and other binary files
              const content = await sandbox.files.read(remotePath, { format: 'bytes' });

              // Determine MIME type
              const mimeType = mime.lookup(filename) || 'application/octet-stream';

              // Upload to Supabase Storage (stored under userId, not agent-scoped)
              const fileId = crypto.randomUUID();
              const { storage_path } = await uploadToStorage(
                userId,
                Buffer.from(content),
                filename,
                mimeType
              );

              outputFiles.push({
                id: fileId,
                storage_path,
                original_filename: filename,
                mime_type: mimeType,
                size_bytes: content.length,
                created_at: new Date().toISOString(),
              });

              log.info(`Extracted output file: ${filename} (${content.length} bytes)`);
            } catch (fileErr) {
              log.error(`Failed to extract file ${filename}`, {
                error: fileErr instanceof Error ? fileErr.message : String(fileErr),
              });
            }
          }
        }

        log.info(`Extracted ${outputFiles.length} output files from ${OUTPUT_DIR}`);
      } catch (extractErr) {
        log.error('Failed to extract output files', {
          error: extractErr instanceof Error ? extractErr.message : String(extractErr),
        });
      }

      // Also extract any additional file paths specified (e.g., from verifier structured_response)
      if (additionalPaths && additionalPaths.length > 0) {
        log.info(`Extracting ${additionalPaths.length} additional file paths`);

        for (const filePath of additionalPaths) {
          // Skip if already extracted (might be in output dir)
          const filename = filePath.split('/').pop() || '';
          if (outputFiles.some((f) => f.original_filename === filename)) {
            log.info(`Skipping ${filename} - already extracted from ${OUTPUT_DIR}`);
            continue;
          }

          try {
            // Verify file exists
            const checkResult = await sandbox.commands.run(
              `test -f "${filePath}" && echo "EXISTS"`,
              { timeoutMs: 3000 }
            );
            if (!checkResult.stdout?.includes('EXISTS')) {
              log.info(`File not found: ${filePath}`);
              continue;
            }

            // Read file content
            const content = await sandbox.files.read(filePath, { format: 'bytes' });
            const mimeType = mime.lookup(filename) || 'application/octet-stream';

            // Upload to Supabase Storage
            const fileId = crypto.randomUUID();
            const { storage_path } = await uploadToStorage(
              userId,
              Buffer.from(content),
              filename,
              mimeType
            );

            outputFiles.push({
              id: fileId,
              storage_path,
              original_filename: filename,
              mime_type: mimeType,
              size_bytes: content.length,
              created_at: new Date().toISOString(),
            });

            log.info(`Extracted additional file: ${filePath} (${content.length} bytes)`);
          } catch (fileErr) {
            log.error(`Failed to extract additional file ${filePath}`, {
              error: fileErr instanceof Error ? fileErr.message : String(fileErr),
            });
          }
        }
      }
    }

    // Kill the sandbox
    await sandbox.kill();
    log.info(`Killed sandbox: ${session.sandboxId}`);
  } catch (error) {
    log.error('Failed to kill sandbox', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Continue to update DB even if kill fails
  }

  // Update DB
  await prisma.claudeCodeSession.update({
    where: { id: taskId },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
    },
  });

  log.info(`Session closed: ${taskId}`);

  return { outputFiles, usage };
}

/**
 * Get session info from database.
 */
export async function getClaudeCodeSession(taskId: string) {
  return await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
  });
}

/**
 * Get session by sandbox ID.
 */
export async function getClaudeCodeSessionBySandboxId(sandboxId: string) {
  return await prisma.claudeCodeSession.findUnique({
    where: { sandboxId },
  });
}

/**
 * Connect to an existing sandbox for automation.
 * Returns the sandbox instance for running commands.
 */
export async function connectToSandbox(sandboxId: string): Promise<Sandbox> {
  if (!process.env.E2B_API_KEY) {
    throw new Error('E2B_API_KEY not configured');
  }

  return await Sandbox.connect(sandboxId, {
    apiKey: process.env.E2B_API_KEY,
  });
}
