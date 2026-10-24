import { unregisterWorkspaceExecutor } from './projects/workspaceExecutor';
import { Sandbox } from 'e2b';
import { Prisma } from '@prisma/client';
import mime from 'mime-types';
import { CODE_AGENT_HANDOFF_PATH, CODE_AGENT_OUTPUT_DIR } from './codeAgentPrompt';
import { randomUUID } from './crypto';
import { prisma } from './database';
import { createLogger } from './logger';
import { type FilePointer, uploadToStorage } from './storage';
import { closeLocalClaudeCodeSession, isLocalClaudeCodeSandboxId } from './claudeCodeLocalSession';
import { checkpointCodeSession, type RepoFacts } from './codeSessions/lifecycle';
import { e2bSandboxFs, localSandboxFs } from './codeSessions/sandboxFs';
import { markPaused, type CodeSessionRow } from './codeSessions/store';
import { resolveMergeFacts, type CodeSessionMergeFacts } from './codeSessions/mergeFacts';
import { isLocalDeviceSandboxId } from './localDevices/hub';
import { closeLocalDeviceCodeSession } from './localDevices/session';

const log = createLogger('E2B');
const OUTPUT_DIR = CODE_AGENT_OUTPUT_DIR;

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

/** Facts the code-agent tool result reports about the persistent session. */
/** The code agent's handoff file at close (absent for sessions that run outside E2B). */
export type CodeAgentHandoff =
  | { status: 'present'; content: string }
  | { status: 'missing' }
  | { status: 'unreadable'; error: string };

/**
 * Read and consume the handoff file. A persistent sandbox outlives this spawn,
 * so the file is removed once read: the next spawn must write its own result.
 */
export async function readCodeAgentHandoff(
  files: Pick<Sandbox['files'], 'exists' | 'read' | 'remove'>
): Promise<CodeAgentHandoff> {
  let content: string;
  try {
    if (!(await files.exists(CODE_AGENT_HANDOFF_PATH))) return { status: 'missing' };
    content = await files.read(CODE_AGENT_HANDOFF_PATH, { format: 'text' });
  } catch (err) {
    return { status: 'unreadable', error: err instanceof Error ? err.message : String(err) };
  }
  try {
    await files.remove(CODE_AGENT_HANDOFF_PATH);
  } catch (err) {
    log.error('Failed to consume code-agent handoff file', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { status: 'present', content };
}

export interface CodeSessionCloseFacts {
  code_session_id: string;
  state: string;
  checkpoint_seq: number | null;
  cli_session_id: string | null;
  /** Branch this session works on and where it merges (plan §1b). */
  branch: string | null;
  merge_target: string | null;
  repo: RepoFacts | null;
  /** merged=true only when GitHub confirms the PR merged and the target contains head. */
  merge: CodeSessionMergeFacts;
}

async function closeFacts(
  row: CodeSessionRow,
  checkpoint: { seq: number; cliSessionId: string | null; repo: RepoFacts | null } | null,
  state: string
): Promise<CodeSessionCloseFacts> {
  const stored = (row.lastRepoFacts ?? null) as
    (RepoFacts & { merge?: CodeSessionMergeFacts }) | null;
  const repo = checkpoint?.repo ?? stored ?? null;
  const merge = await resolveMergeFacts({
    repoUrl: row.repoUrl,
    repo,
    mergeTarget: row.mergeTarget,
    previous: stored?.merge ?? null,
  });
  if (merge.source === 'github' && repo !== null) {
    await prisma.codeSession
      .update({
        where: { id: row.id },
        data: { lastRepoFacts: { ...repo, merge } as unknown as Prisma.InputJsonValue },
      })
      .catch(() => undefined);
  }
  return {
    code_session_id: row.id,
    state,
    checkpoint_seq:
      checkpoint?.seq ?? (row.latestCheckpointSeq > 0 ? row.latestCheckpointSeq : null),
    cli_session_id: checkpoint?.cliSessionId ?? row.cliSessionId,
    branch: row.branch ?? repo?.branch ?? null,
    merge_target: merge.merge_target ?? row.mergeTarget,
    repo,
    merge,
  };
}

/**
 * Whether this task still owns its code session's sandbox. A later spawn may
 * already have resumed the same sandbox; closing the older task must not
 * checkpoint over it or pause it underneath the newer one.
 */
async function ownsCodeSessionSandbox(
  session: { id: string; sandboxId: string; createdAt: Date; codeSessionId: string | null },
  codeSession: CodeSessionRow
): Promise<boolean> {
  if (codeSession.sandboxId !== session.sandboxId) return false;
  const newer = await prisma.claudeCodeSession.findFirst({
    where: { codeSessionId: codeSession.id, createdAt: { gt: session.createdAt } },
    select: { id: true },
  });
  return newer === null;
}

export async function closeClaudeCodeSession(
  taskId: string,
  userId?: string,
  agentId?: string,
  additionalPaths?: string[],
  options?: { reason?: string }
): Promise<{
  outputFiles: FilePointer[];
  usage?: ClaudeCodeUsage;
  codeSession?: CodeSessionCloseFacts;
  handoff?: CodeAgentHandoff;
}> {
  log.info(`Closing Claude Code session ${taskId}`);

  const session = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
  });

  if (!session) {
    throw new Error(`Claude Code session not found: ${taskId}`);
  }

  const reason = options?.reason ?? 'close';
  if (session.status !== 'CLOSED') {
    // The code-agents list reports a resumable close (idle, user pause, a
    // question to the parent, a usage limit) as PAUSED. A retried close keeps
    // the first reason.
    await prisma.claudeCodeSession.update({ where: { id: taskId }, data: { closeReason: reason } });
  }
  const codeSession =
    session.codeSessionId !== null
      ? await prisma.codeSession.findUnique({ where: { id: session.codeSessionId } })
      : null;
  const ownsSandbox =
    codeSession !== null &&
    codeSession.state !== 'RETIRED' &&
    (await ownsCodeSessionSandbox(session, codeSession));

  if (codeSession !== null && session.status === 'CLOSED') {
    // Retried close: the session was already checkpointed and paused.
    return { outputFiles: [], codeSession: await closeFacts(codeSession, null, codeSession.state) };
  }

  if (isLocalClaudeCodeSandboxId(session.sandboxId)) {
    let checkpoint = null;
    if (codeSession !== null && ownsSandbox && codeSession.homeDir !== null) {
      checkpoint = await checkpointCodeSession({
        session: codeSession,
        fs: localSandboxFs(codeSession.homeDir),
        reason,
        agentId: session.agentId,
      });
    }
    const local = await closeLocalClaudeCodeSession(taskId, userId, additionalPaths);
    if (codeSession !== null && ownsSandbox) await markPaused(codeSession.id);
    return {
      outputFiles: local.outputFiles,
      ...(codeSession !== null
        ? {
            codeSession: await closeFacts(
              codeSession,
              checkpoint,
              ownsSandbox ? 'PAUSED' : codeSession.state
            ),
          }
        : {}),
    };
  }

  if (isLocalDeviceSandboxId(session.sandboxId)) {
    // The work stays in the user's Mac folder; nothing is uploaded from their disk.
    return await closeLocalDeviceCodeSession(taskId, session.sandboxId);
  }

  const outputFiles: FilePointer[] = [];
  let usage: ClaudeCodeUsage | undefined;
  let codeSessionFacts: CodeSessionCloseFacts | undefined;
  let handoff: CodeAgentHandoff | undefined;

  try {
    // Connect to sandbox
    const sandbox = await Sandbox.connect(session.sandboxId, {
      apiKey: process.env.E2B_API_KEY,
    });

    handoff = await readCodeAgentHandoff(sandbox.files);

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
              const fileId = randomUUID();
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
            const fileId = randomUUID();
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

    // The project workspace executor belongs to this task either way.
    unregisterWorkspaceExecutor(taskId);
    if (codeSession !== null && ownsSandbox) {
      // Persistent session: checkpoint, then pause (fs + memory survive).
      const checkpoint = await checkpointCodeSession({
        session: codeSession,
        fs: e2bSandboxFs(sandbox),
        reason,
        agentId: session.agentId,
      });
      await sandbox.pause();
      await markPaused(codeSession.id);
      codeSessionFacts = await closeFacts(codeSession, checkpoint, 'PAUSED');
      log.info(`Paused sandbox: ${session.sandboxId} (code session ${codeSession.id})`);
    } else if (codeSession !== null) {
      // A newer spawn resumed this sandbox; leave it running for that spawn.
      codeSessionFacts = await closeFacts(codeSession, null, codeSession.state);
    } else {
      await sandbox.kill();
      log.info(`Killed sandbox: ${session.sandboxId}`);
    }
  } catch (error) {
    if (codeSession !== null && ownsSandbox)
      await markPaused(codeSession.id).catch(() => undefined);
    log.error('Failed to pause/kill sandbox', {
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

  if (codeSessionFacts === undefined && codeSession !== null) {
    codeSessionFacts = await closeFacts(codeSession, null, codeSession.state);
  }
  return {
    outputFiles,
    usage,
    ...(codeSessionFacts !== undefined ? { codeSession: codeSessionFacts } : {}),
    ...(handoff !== undefined ? { handoff } : {}),
  };
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
  // A persistent code session reuses one sandbox across spawns: newest wins.
  return await prisma.claudeCodeSession.findFirst({
    where: { sandboxId },
    orderBy: { createdAt: 'desc' },
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
