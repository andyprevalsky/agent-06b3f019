import { unregisterWorkspaceExecutor } from './projects/workspaceExecutor';
import { InvalidArgumentError, Sandbox } from 'e2b';
import { Prisma } from '@prisma/client';
import mime from 'mime-types';
import { CODE_AGENT_HANDOFF_PATH, CODE_AGENT_OUTPUT_DIR } from './codeAgentPrompt';
import { readCodeAgentHandoff, type CodeAgentHandoff } from './codeAgentHandoff';
import { randomUUID } from './crypto';
import { prisma } from './database';
import { createLogger } from './logger';

export { readCodeAgentHandoff, type CodeAgentHandoff } from './codeAgentHandoff';
import { type FilePointer, uploadToStorage } from './storage';
import { closeLocalClaudeCodeSession, isLocalClaudeCodeSandboxId } from './claudeCodeLocalSession';
import { checkpointCodeSession, type RepoFacts } from './codeSessions/lifecycle';
import { e2bSandboxFs, localSandboxFs, shellQuote } from './codeSessions/sandboxFs';
import { type CodeSessionRow } from './codeSessions/store';
import { withSerializedLock, type SerializedLock } from './sharedState';
import { forgetStartupTurns } from './codeSessions/startupTurns';
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

interface CloseResult {
  outputFiles: FilePointer[];
  usage?: ClaudeCodeUsage;
  codeSession?: CodeSessionCloseFacts;
  handoff?: CodeAgentHandoff;
}

interface CloseReceipt {
  version: 1;
  complete: boolean;
  extracted: boolean;
  result: CloseResult;
  uploads: Record<string, string>;
  phase?: 'collecting' | 'pause_requested' | 'paused';
  localStopped?: boolean;
}

/** One task closes once across backend instances; HTTP response loss only replays its receipt. */
export async function closeClaudeCodeSession(
  taskId: string,
  userId?: string,
  agentId?: string,
  additionalPaths?: string[],
  options?: { reason?: string }
): Promise<CloseResult> {
  return withSerializedLock(`code-session-close:${taskId}`, (lock) =>
    runClaudeCodeClose(taskId, lock, userId, agentId, additionalPaths, options)
  );
}

async function runClaudeCodeClose(
  taskId: string,
  lock: SerializedLock,
  userId?: string,
  agentId?: string,
  additionalPaths?: string[],
  options?: { reason?: string }
): Promise<CloseResult> {
  log.info(`Closing Claude Code session ${taskId}`);

  const session = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
  });

  if (!session) {
    throw new Error(`Claude Code session not found: ${taskId}`);
  }

  const receipt = (session.closeResult as unknown as CloseReceipt | null) ?? {
    version: 1,
    complete: false,
    extracted: false,
    result: { outputFiles: [] },
    uploads: {},
  };
  if (receipt.version !== 1 || !Array.isArray(receipt.result?.outputFiles)) {
    throw new Error(`Invalid close receipt for task ${taskId}`);
  }
  if (receipt.complete) return receipt.result;
  if (session.status === 'CLOSED' && session.closeResult === null) {
    throw new Error(`Closed task ${taskId} has no persisted close result`);
  }
  const writeReceipt = async (db: Pick<typeof prisma, '$executeRaw'>, closed = false) => {
    const count = await db.$executeRaw`
      UPDATE "ClaudeCodeSession"
      SET "closeResult" = ${JSON.stringify(receipt)}::jsonb,
          status = CASE WHEN ${closed} THEN 'CLOSED'::"ClaudeCodeSessionStatus" ELSE status END,
          "closedAt" = CASE WHEN ${closed} THEN now() ELSE "closedAt" END
      WHERE id = ${taskId} AND ${lock.predicate}
    `;
    if (count !== 1) throw new Error(`Close custody lost for task ${taskId}`);
  };
  const saveReceipt = () => writeReceipt(prisma);
  const finish = async (result: CloseResult, paused?: CodeSessionRow): Promise<CloseResult> => {
    // Return the same JSON value the receipt stores, including on the first call.
    receipt.result = JSON.parse(JSON.stringify(result)) as CloseResult;
    receipt.complete = true;
    await prisma.$transaction(async (tx) => {
      await writeReceipt(tx, true);
      if (paused !== undefined) {
        const released = await tx.codeSession.updateMany({
          where: {
            id: paused.id,
            sandboxId: paused.sandboxId,
            leaseOwner: paused.leaseOwner,
            closingTaskId: taskId,
            closingEpoch: lock.token,
            state: { not: 'RETIRED' },
          },
          data: {
            state: 'PAUSED',
            leaseOwner: null,
            leaseExpiresAt: null,
            lastActiveAt: new Date(),
            closingTaskId: null,
            closingEpoch: null,
          },
        });
        if (released.count !== 1)
          throw new Error(`Code session owner changed while closing task ${taskId}`);
      } else {
        // A superseded close may drop only its own custody, never the newer
        // task's ordinary lease or provider state.
        await tx.codeSession.updateMany({
          where: {
            id: session.codeSessionId ?? '',
            closingTaskId: taskId,
            closingEpoch: lock.token,
          },
          data: { closingTaskId: null, closingEpoch: null },
        });
      }
    });
    return receipt.result;
  };
  // Lock only the final provider transition, never extraction or checkpointing.
  // The durable session custody remains set if this bounded transaction aborts.
  const confirmPause = async (
    owned: CodeSessionRow,
    confirm: () => Promise<boolean>
  ): Promise<void> => {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT key FROM "SharedEphemeralState"
        WHERE namespace = 'serialized-lock' AND key = ${`code-session-close:${taskId}`}
        FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "CodeSession" WHERE id = ${owned.id} FOR UPDATE`;
        const [held] = await tx.$queryRaw<
          Array<{ held: boolean }>
        >`SELECT ${lock.predicate} AS held`;
        const current = await tx.codeSession.findUniqueOrThrow({ where: { id: owned.id } });
        const newer = await tx.claudeCodeSession.findFirst({
          where: {
            codeSessionId: owned.id,
            createdAt: { gt: session.createdAt },
          },
          select: { id: true },
        });
        if (
          !held?.held ||
          newer !== null ||
          current.closingTaskId !== taskId ||
          current.closingEpoch !== lock.token ||
          current.sandboxId !== owned.sandboxId ||
          current.leaseOwner !== owned.leaseOwner ||
          current.state === 'RETIRED'
        ) {
          throw new Error(`Close custody lost before provider pause for task ${taskId}`);
        }
        if (!(await confirm()))
          throw new Error(`Code session pause remains unconfirmed for task ${taskId}`);
        receipt.phase = 'paused';
        await writeReceipt(tx);
      },
      { timeout: 65_000 }
    );
  };

  const reason = session.closeReason ?? options?.reason ?? 'close';
  if (session.status !== 'CLOSED') {
    // The code-agents list reports a resumable close (idle, user pause, a
    // question to the parent, a usage limit) as PAUSED. A retried close keeps
    // the first reason.
    const updated = await prisma.$executeRaw`
      UPDATE "ClaudeCodeSession" SET "closeReason" = COALESCE("closeReason", ${reason})
      WHERE id = ${taskId} AND ${lock.predicate}
    `;
    if (updated !== 1) throw new Error(`Close custody lost for task ${taskId}`);
  }
  const codeSession =
    session.codeSessionId !== null
      ? await prisma.codeSession.findUnique({ where: { id: session.codeSessionId } })
      : null;
  const ownsSandbox =
    codeSession !== null &&
    codeSession.state !== 'RETIRED' &&
    (await ownsCodeSessionSandbox(session, codeSession));

  // Cleanup callers omit identity. Output ownership still comes from the task,
  // never from whether the caller happened to repeat its user/agent fields.
  const ownerId =
    codeSession?.userId ??
    (
      await prisma.agent.findUnique({
        where: { id: session.agentId },
        select: { userId: true },
      })
    )?.userId;
  if (ownerId) {
    if (userId !== undefined && userId !== ownerId) throw new Error('Code close owner mismatch');
    userId = ownerId;
  }
  agentId = session.agentId;

  if (ownsSandbox && codeSession?.leaseOwner?.startsWith('tool:') === true) {
    // The task's startup row (messages queued before it existed) is spent.
    await forgetStartupTurns(codeSession.leaseOwner).catch((error: unknown) => {
      log.warn('Dropping the startup message row failed', { taskId, error: String(error) });
    });
  }

  if (codeSession !== null && !ownsSandbox) {
    unregisterWorkspaceExecutor(taskId);
    return finish({
      ...receipt.result,
      codeSession: await closeFacts(codeSession, null, codeSession.state),
    });
  }

  if (codeSession !== null) {
    await lock.assertHeld();
    const claimed = await prisma.$executeRaw`
      UPDATE "CodeSession" SET "closingTaskId" = ${taskId}, "closingEpoch" = ${lock.token}
      WHERE id = ${codeSession.id} AND "sandboxId" = ${codeSession.sandboxId}
        AND "leaseOwner" IS NOT DISTINCT FROM ${codeSession.leaseOwner}
        AND ("closingTaskId" IS NULL OR "closingTaskId" = ${taskId})
        AND ${lock.predicate}
        AND NOT EXISTS (SELECT 1 FROM "ClaudeCodeSession" newer
          WHERE newer."codeSessionId" = ${codeSession.id} AND newer."createdAt" > ${session.createdAt})
    `;
    if (claimed !== 1) throw new Error(`Close custody unavailable for task ${taskId}`);
  }

  if (isLocalClaudeCodeSandboxId(session.sandboxId)) {
    if (receipt.localStopped) return finish(receipt.result, codeSession ?? undefined);
    let checkpoint = null;
    if (codeSession !== null && ownsSandbox && codeSession.homeDir !== null) {
      checkpoint = await checkpointCodeSession({
        session: codeSession,
        fs: localSandboxFs(codeSession.homeDir),
        reason,
        agentId: session.agentId,
      });
    }
    const local = await closeLocalClaudeCodeSession(
      taskId,
      userId,
      additionalPaths,
      async (result) => {
        receipt.result = {
          ...result,
          ...(codeSession !== null
            ? { codeSession: await closeFacts(codeSession, checkpoint, 'PAUSED') }
            : {}),
        };
        receipt.localStopped = true;
        receipt.extracted = true;
        await saveReceipt();
      }
    );
    return finish(
      {
        outputFiles: local.outputFiles,
        ...(local.handoff !== undefined ? { handoff: local.handoff } : {}),
        ...(codeSession !== null
          ? {
              codeSession: await closeFacts(
                codeSession,
                checkpoint,
                ownsSandbox ? 'PAUSED' : codeSession.state
              ),
            }
          : {}),
      },
      codeSession !== null && ownsSandbox ? codeSession : undefined
    );
  }

  if (isLocalDeviceSandboxId(session.sandboxId)) {
    // The work stays in the user's Mac folder; nothing is uploaded from their disk.
    return finish(await closeLocalDeviceCodeSession(taskId, session.sandboxId));
  }

  // A provider pause may have succeeded just before the final database write
  // failed. Inspect without connect(), which would resume that paused sandbox.
  if (receipt.phase === 'paused' && codeSession !== null)
    return finish(receipt.result, codeSession);
  if (receipt.phase === 'pause_requested' && codeSession !== null) {
    await confirmPause(codeSession, async () => {
      const info = await Sandbox.getInfo(session.sandboxId, {
        apiKey: process.env.E2B_API_KEY,
        requestTimeoutMs: 60_000,
      });
      return info.state === 'paused';
    });
    return finish(receipt.result, codeSession);
  }

  const outputFiles = receipt.result.outputFiles;
  let usage = receipt.result.usage;
  let codeSessionFacts: CodeSessionCloseFacts | undefined;
  let handoff = receipt.result.handoff;
  let pausedSession: CodeSessionRow | undefined;

  try {
    // Connect to sandbox
    const sandbox = await Sandbox.connect(session.sandboxId, {
      apiKey: process.env.E2B_API_KEY,
    });

    if (handoff === undefined) {
      handoff = await readCodeAgentHandoff({
        exists: (path) => sandbox.files.exists(path),
        read: (path, opts) => sandbox.files.read(path, opts),
        // Persist the handoff before consuming it: a backend restart must not lose it.
        remove: async () => {},
      });
      receipt.result.handoff = handoff;
      await saveReceipt();
    }
    if (
      !receipt.extracted &&
      handoff.status === 'present' &&
      (await sandbox.files.exists(CODE_AGENT_HANDOFF_PATH))
    ) {
      await sandbox.files.remove(CODE_AGENT_HANDOFF_PATH);
    }

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

    if (!receipt.extracted && userId && agentId) {
      const extract = async (path: string): Promise<void> => {
        const filename = path.split('/').pop() ?? '';
        if (outputFiles.some((file) => file.original_filename === filename)) return;
        const content = Buffer.from(await sandbox.files.read(path, { format: 'bytes' }));
        const mimeType = mime.lookup(filename) || 'application/octet-stream';
        const fileId = receipt.uploads[path] ?? randomUUID();
        receipt.uploads[path] = fileId;
        await saveReceipt();
        const { storage_path } = await uploadToStorage(userId, content, filename, mimeType, {
          objectId: fileId,
        });
        outputFiles.push({
          id: fileId,
          storage_path,
          original_filename: filename,
          mime_type: mimeType,
          size_bytes: content.length,
          created_at: new Date().toISOString(),
        });
        await saveReceipt();
      };
      const found = await sandbox.commands.run(
        `find ${OUTPUT_DIR} -maxdepth 1 -type f -printf '%f\\n' 2>/dev/null || echo "NO_DIR"`,
        { timeoutMs: 5000 }
      );
      if (found.stdout && !found.stdout.includes('NO_DIR')) {
        for (const filename of found.stdout.split('\n').filter(Boolean)) {
          await extract(`${OUTPUT_DIR}/${filename}`);
        }
      }
      for (const path of additionalPaths ?? []) {
        const found = await sandbox.commands.run(`test -f ${shellQuote(path)} && echo EXISTS`, {
          timeoutMs: 3000,
        });
        if (found.stdout?.includes('EXISTS')) await extract(path);
      }
    }
    receipt.result.usage = usage;
    receipt.extracted = true;
    await saveReceipt();

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
      const current = await prisma.codeSession.findUniqueOrThrow({ where: { id: codeSession.id } });
      if (
        current.state !== 'RETIRED' &&
        current.leaseOwner === codeSession.leaseOwner &&
        (await ownsCodeSessionSandbox(session, current))
      ) {
        codeSessionFacts = await closeFacts(current, checkpoint, 'PAUSED');
        receipt.result = {
          outputFiles,
          ...(usage !== undefined ? { usage } : {}),
          codeSession: codeSessionFacts,
          ...(handoff !== undefined ? { handoff } : {}),
        };
        receipt.phase = 'pause_requested';
        await saveReceipt();
        let pauseDispatched = false;
        try {
          await confirmPause(current, async () => {
            pauseDispatched = true;
            await sandbox.pause({ requestTimeoutMs: 60_000 });
            return true;
          });
        } catch (error) {
          // Admission/validation failure before dispatch and a definite API
          // rejection can retry. A dispatched transport failure stays uncertain.
          if (!pauseDispatched || error instanceof InvalidArgumentError) {
            receipt.phase = 'collecting';
            await saveReceipt();
          }
          throw error;
        }
        pausedSession = current;
        log.info(`Paused sandbox: ${session.sandboxId} (code session ${codeSession.id})`);
      } else {
        codeSessionFacts = await closeFacts(current, null, current.state);
      }
    } else if (codeSession !== null) {
      // A newer spawn resumed this sandbox; leave it running for that spawn.
      codeSessionFacts = await closeFacts(codeSession, null, codeSession.state);
    } else {
      await sandbox.kill();
      log.info(`Killed sandbox: ${session.sandboxId}`);
    }
  } catch (error) {
    log.error('Failed to pause/kill sandbox', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (codeSessionFacts === undefined && codeSession !== null) {
    codeSessionFacts = await closeFacts(codeSession, null, codeSession.state);
  }
  const result = await finish(
    {
      outputFiles,
      usage,
      ...(codeSessionFacts !== undefined ? { codeSession: codeSessionFacts } : {}),
      ...(handoff !== undefined ? { handoff } : {}),
    },
    pausedSession
  );
  log.info(`Session closed: ${taskId}`);
  return result;
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
