/**
 * Close result of one code-agent task (its consumed handoff + extracted output
 * files), stored once when close reads them so a retried close returns the same
 * result, as the local fallback does from its session.json.
 *
 *   close ─► read+consume handoff, extract outputs ─► saveCloseRecord ─► checkpoint ─► pause
 *   retried close (task CLOSED) ─► loadCloseRecord ─► same handoff + outputFiles
 *   retire ─► deleteCloseRecords (one per task of the session)
 *
 * Write-once (the object store never overwrites a key), so a concurrent retry
 * that found the handoff already consumed cannot replace the first result.
 */
import { prisma } from '../database';
import { createLogger } from '../logger';
import { type CodeAgentHandoff, isCodeAgentHandoff } from '../codeAgentHandoff';
import { isFilePointer } from '../claudeCodeLocalOwnership';
import type { FilePointer } from '../storage';
import {
  closeRecordKey,
  deleteCheckpointObject,
  getCheckpointObject,
  putCheckpointObject,
} from './artifactStore';

const log = createLogger('CodeSessionCloseRecord');

export interface CloseRecord {
  handoff?: CodeAgentHandoff;
  outputFiles: FilePointer[];
}

interface SessionRef {
  id: string;
  userId: string;
}

/** Best-effort: a failed write is logged and never fails the close. */
export async function saveCloseRecord(
  session: SessionRef,
  taskId: string,
  record: CloseRecord
): Promise<void> {
  try {
    await putCheckpointObject(
      closeRecordKey(session.userId, session.id, taskId),
      Buffer.from(JSON.stringify(record), 'utf8')
    );
  } catch (error) {
    log.warn('Storing the close record failed', {
      codeSessionId: session.id,
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The stored close result, or null when none was stored (or it is unreadable). */
export async function loadCloseRecord(
  session: SessionRef,
  taskId: string
): Promise<CloseRecord | null> {
  try {
    const raw = await getCheckpointObject(closeRecordKey(session.userId, session.id, taskId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw.toString('utf8')) as { handoff?: unknown; outputFiles?: unknown };
    return {
      ...(isCodeAgentHandoff(parsed.handoff) ? { handoff: parsed.handoff } : {}),
      outputFiles: Array.isArray(parsed.outputFiles)
        ? parsed.outputFiles.filter(isFilePointer)
        : [],
    };
  } catch (error) {
    log.warn('Reading the close record failed', {
      codeSessionId: session.id,
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Delete every task's close record of a retiring session. */
export async function deleteCloseRecords(session: SessionRef): Promise<void> {
  const tasks = await prisma.claudeCodeSession.findMany({
    where: { codeSessionId: session.id },
    select: { id: true },
  });
  for (const task of tasks) {
    await deleteCheckpointObject(closeRecordKey(session.userId, session.id, task.id));
  }
}
