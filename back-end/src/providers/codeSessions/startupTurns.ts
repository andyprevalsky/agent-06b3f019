/**
 * Messages sent to a code agent whose session does not exist yet.
 *
 * A background code spawn registers its task at once, but its sandbox, repo
 * clone and ws-server take minutes (createWithCodeSession is still running).
 * Until that create returns there is no session to address, and a refusal
 * ("has not started yet") made the sender retry blindly. The message is queued
 * here instead and delivered, in arrival order, when the create returns:
 *
 *   sender ─▶ lock(spawn) ─┬─ session published ─▶ deliver as usual (caller)
 *                          └─ not yet ─▶ append to the spawn's row ─▶ "queued"
 *   create returns ─▶ lock(spawn) ─▶ deliver the row's turns to the ws-server
 *                                   (which queues them again until the CLI has
 *                                   the task prompt) ─▶ publish the session
 *
 * Enqueue and publish take the same per-spawn lock, so a sender either sees
 * the published session or its turn is in the row the drain reads: none is lost
 * and none is delivered ahead of an earlier one. Exactly once: a turn's CLI id
 * is derived from its key and the ws-server dedupes ids, so a retried send, a
 * replayed create or a drain that ran twice never writes a second turn.
 *
 * One row per spawn tool call (key `tool:<agent>:<call>`, the create's lease
 * owner), at most MAX_STARTUP_TURNS turns and MAX_STARTUP_CHARS characters:
 * cost grows with spawns, never with the agents that talk to one. The row
 * expires after STARTUP_ROW_TTL_MS and is deleted when the task closes.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { deliverUserTurnToCodeSession, type CodeTurnSettings } from '../codeSessionTurns';
import { prepareDirectTurnAttachments, type DirectAttachment } from './directTurnAttachments';
import { deleteEphemeral, getEphemeral, putEphemeral, withSerializedLock } from '../sharedState';
import {
  agentMessageRowFields,
  codeTurnId,
  recordCodeTimelineRow,
  type CodeAgentProvider,
} from './agentMessageRows';

const log = createLogger('CodeStartupTurns');

const NAMESPACE = 'code-startup-turns';
/** A lock holder only reads, appends or delivers a handful of turns. */
const LOCK_WAIT_MS = 30_000;
const STARTUP_ROW_TTL_MS = 6 * 60 * 60_000;

export const MAX_STARTUP_TURNS = 10;
export const MAX_STARTUP_CHARS = 100_000;

/** One message waiting for its code agent's session. */
export interface StartupTurn {
  /** The send's idempotency key (`a2a:<sender>:<key>`): the dedupe and CLI turn id source. */
  key: string;
  /** The text the CLI receives (sender framing included). */
  text: string;
  /** The sender's own words, for the timeline chip. */
  original: string;
  sender: { id: string; label: string };
  toolCallId: string;
  /**
   * The owner typed it while the code agent was resuming (directChatResume.ts):
   * its CLI turn id is the client message id (the person's row already exists),
   * with the turn's attachments and model / effort / speed.
   */
  user?: {
    clientMessageId: string;
    userId: string;
    attachments?: Array<Record<string, unknown>>;
    settings?: CodeTurnSettings;
  };
}

interface StartupRow {
  turns: StartupTurn[];
  /** The session this spawn's create published (a woken run publishes its own later). */
  published: { taskId: string } | null;
}

const EMPTY_ROW: StartupRow = { turns: [], published: null };

/** The create's lease owner, which names one spawn tool call. */
export function startupTurnsKey(ownerAgentId: string, toolCallId: string): string {
  return `tool:${ownerAgentId}:${toolCallId}`.slice(0, 200);
}

async function readRow(key: string): Promise<StartupRow> {
  return (await getEphemeral<StartupRow>(NAMESPACE, key)) ?? EMPTY_ROW;
}

async function writeRow(key: string, row: StartupRow): Promise<void> {
  await putEphemeral(NAMESPACE, key, row as unknown as Prisma.InputJsonValue, STARTUP_ROW_TTL_MS);
}

function lockName(key: string): string {
  return `${NAMESPACE}:${key}`;
}

/** The session the spawn's create last published, or null (not yet, or expired). */
export async function publishedStartupTask(key: string): Promise<string | null> {
  return (await readRow(key)).published?.taskId ?? null;
}

/** How many messages wait in the spawn's startup row. */
export async function queuedStartupTurnCount(key: string): Promise<number> {
  return (await readRow(key)).turns.length;
}

export type EnqueueOutcome<S> =
  { status: 'started'; session: S } | { status: 'queued'; position: number } | { status: 'full' };

/**
 * Queue `turn` unless the spawn's session exists by now. `findStarted` is
 * re-run under the spawn lock (it gets the published task id), so a send racing
 * the create's publish either finds the session or is in the row the drain reads.
 * `admit` runs only for a turn that is actually added (the sender's rate limit:
 * a retried send of a queued turn is free) and may throw to refuse it.
 */
export async function enqueueStartupTurn<S>(
  key: string,
  turn: StartupTurn,
  deps: {
    findStarted: (publishedTaskId: string | null) => Promise<S | null>;
    admit: () => Promise<void>;
  }
): Promise<EnqueueOutcome<S>> {
  return withSerializedLock(
    lockName(key),
    async () => {
      const row = await readRow(key);
      const started = await deps.findStarted(row.published?.taskId ?? null);
      if (started !== null) return { status: 'started', session: started };
      const queuedAt = row.turns.findIndex((queued) => queued.key === turn.key);
      if (queuedAt >= 0) return { status: 'queued', position: queuedAt + 1 };
      const chars = row.turns.reduce((sum, queued) => sum + queued.text.length, turn.text.length);
      if (row.turns.length >= MAX_STARTUP_TURNS || chars > MAX_STARTUP_CHARS) {
        return { status: 'full' };
      }
      await deps.admit();
      await writeRow(key, { ...row, turns: [...row.turns, turn] });
      return { status: 'queued', position: row.turns.length + 1 };
    },
    { waitMs: LOCK_WAIT_MS }
  );
}

/**
 * The spawn's create returned `taskId`: deliver the queued turns in order, then
 * publish the session so later senders address it directly. Safe to run again
 * (a replayed create): ids dedupe at the ws-server and the chip rows are
 * idempotent. A turn the session refuses is logged, not retried: the CLI ended
 * during startup and the task's own result reports that.
 */
export async function drainStartupTurns(key: string, taskId: string): Promise<void> {
  await withSerializedLock(
    lockName(key),
    async () => {
      const row = await readRow(key);
      const session = await prisma.claudeCodeSession.findUnique({
        where: { id: taskId },
        select: { id: true, agentId: true, streamUrl: true, codeProvider: true },
      });
      if (session === null || session.streamUrl === null) {
        log.error('Queued code agent messages have no session to go to', {
          taskId,
          queued: String(row.turns.length),
        });
        return;
      }
      const provider: CodeAgentProvider | null =
        session.codeProvider === 'claude' || session.codeProvider === 'codex'
          ? session.codeProvider
          : null;
      for (const turn of row.turns) {
        const turnId = turn.user?.clientMessageId ?? codeTurnId(turn.key);
        // The ws-server holds only `agent` turns until the CLI has its task prompt,
        // so a person's queued turn rides that path with its own id and settings.
        const extras = turn.user ? await personTurnExtras(turn.user) : {};
        const deliver = (withSettings: boolean) =>
          deliverUserTurnToCodeSession({
            wsUrl: session.streamUrl as string,
            taskId,
            turnId,
            text: turn.text,
            sender: 'agent',
            ...extras,
            ...(withSettings ? {} : { settings: undefined }),
          });
        let delivery = await deliver(true);
        if (delivery.status === 'rejected' && delivery.reason === 'unsupported_settings') {
          // The resumed session's catalog lacks the model/speed picked while it was
          // stopped: the person's words still reach it, on the session's settings.
          log.warn('A queued turn asked for settings the resumed session lacks', {
            taskId,
            turnId,
          });
          delivery = await deliver(false);
        }
        if (
          delivery.status !== 'delivered' &&
          delivery.status !== 'duplicate' &&
          delivery.status !== 'queued'
        ) {
          log.error('A queued code agent message was not delivered', {
            taskId,
            turnId,
            status: delivery.status,
            reason: delivery.reason,
          });
          continue;
        }
        if (turn.user) continue; // the person's own row was persisted when it queued
        const fields = agentMessageRowFields({
          key: turn.key,
          sender: turn.sender,
          session: { id: taskId, provider },
          original: turn.original,
        });
        await recordCodeTimelineRow({
          ownerAgentId: session.agentId,
          sessionId: taskId,
          provider,
          toolCallId: turn.toolCallId,
          key: turn.key,
          title: fields.title,
          text: turn.original,
          a2a: fields.a2a,
          direction: 'received',
          codeTurnId: turnId,
        });
      }
      await writeRow(key, { turns: [], published: { taskId } });
      if (row.turns.length > 0) {
        log.info('Delivered code agent messages queued during startup', {
          taskId,
          delivered: String(row.turns.length),
        });
      }
    },
    { waitMs: LOCK_WAIT_MS }
  );
}

/** A person's queued turn: its attachments staged for the CLI and its per-turn settings. */
async function personTurnExtras(user: NonNullable<StartupTurn['user']>) {
  const attachments = await prepareDirectTurnAttachments(
    user.attachments as unknown as DirectAttachment[] | undefined,
    user.userId
  ).catch((error: unknown) => {
    log.error('A queued turn lost its attachments', {
      clientMessageId: user.clientMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  });
  return {
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(user.settings ? { settings: user.settings } : {}),
  };
}

/**
 * A new run of the spawn is starting (a person resumed a stopped code agent):
 * its earlier run's published session must not read as this run's, but turns
 * still queued (an earlier resume that failed) stay and reach this run.
 */
export async function clearPublishedStartupTask(key: string): Promise<void> {
  await withSerializedLock(
    lockName(key),
    async () => {
      const row = await readRow(key);
      if (row.published !== null) await writeRow(key, { ...row, published: null });
    },
    { waitMs: LOCK_WAIT_MS }
  );
}

/** The task closed: its startup row has nothing left to do. */
export async function forgetStartupTurns(key: string): Promise<void> {
  await deleteEphemeral(NAMESPACE, key);
}
