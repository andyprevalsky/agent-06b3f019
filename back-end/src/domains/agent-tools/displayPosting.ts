/** Idempotent task and owning-conversation display rows. */
import { createHash } from '../../providers/crypto';
import { createLogger } from '../../providers/logger';
import { deterministicMessageId } from '../../providers/messageIdempotency';
import { createMessage } from '../../providers/messages';
import * as repo from './repo';
import { sandboxRowMetadata, type ToolContext } from './service';
import type { DisplayFilePointer, DisplayItemResult } from './types';
import type { PreparedItem } from './displayTypes';
const log = createLogger('AgentToolsDisplay');

export function itemResult(
  entry: PreparedItem,
  status: DisplayItemResult['status'],
  messageId: string | null,
  pointer: DisplayFilePointer
): DisplayItemResult {
  return {
    index: entry.index,
    status,
    message_id: messageId,
    sha256: entry.sha256,
    mime_type: entry.mimeType,
    kind: entry.kind,
    file_pointer: pointer,
  };
}

/**
 * Where one displayed item lands. A Rose agent's display is one row in its own
 * conversation. A code agent's display is two rows in the session agent's
 * trajectory: one grouped under the code-agent task (its own conversation,
 * subAgentId = task id) and one top-level row in the owning Rose agent's
 * conversation. Both carry the same display.canonical_id so a view that holds
 * both renders it once; each row id is deterministic, so a retry adds nothing.
 */
interface DisplayRowPlan {
  idempotencyKey: string;
  conversation: 'own' | 'parent';
  metadata: Record<string, unknown>;
}

/** One content identity in the owning Rose conversation, shared by task mirrors. */
export function canonicalScope(ctx: ToolContext): string {
  return `agent:${ctx.agent.id}`;
}

export function displayCanonicalId(scope: string, sha256: string): string {
  return `dsp_${createHash('sha256').update(`${scope}:${sha256}`).digest('hex').slice(0, 32)}`;
}

function displayRowPlans(ctx: ToolContext, sha256: string): DisplayRowPlan[] {
  const taskId = ctx.caller.kind === 'code_agent' ? ctx.caller.taskId : null;
  if (taskId === null) {
    return [
      {
        idempotencyKey: `display:${sha256}`,
        conversation: 'own',
        metadata: sandboxRowMetadata(ctx),
      },
    ];
  }
  return [
    {
      idempotencyKey: `display:${sha256}:task:${taskId}`,
      conversation: 'own',
      metadata: sandboxRowMetadata(ctx),
    },
    {
      idempotencyKey: `display:${sha256}`,
      conversation: 'parent',
      metadata: { excludeFromModel: true, displayedBy: { kind: 'code_agent', task_id: taskId } },
    },
  ];
}

async function postRow(
  ctx: ToolContext,
  entry: PreparedItem,
  caption: string,
  canonicalId: string,
  plan: DisplayRowPlan
): Promise<{ id: string; created: boolean; pointer: DisplayFilePointer }> {
  const messageId = deterministicMessageId(ctx.agent.id, plan.idempotencyKey);
  const existing = await repo.findMessage(messageId);
  if (existing) {
    const metadata = existing.metadata as Record<string, unknown> | null;
    // Before dual displays, the generic content key could be a task-grouped
    // row. Keep that historical row and give the owning conversation its own
    // deterministic mirror rather than mistaking the grouped row for one.
    if (plan.metadata.subAgentId === undefined && typeof metadata?.subAgentId === 'string') {
      return postRow(ctx, entry, caption, canonicalId, {
        ...plan,
        idempotencyKey: `${plan.idempotencyKey}:parent`,
      });
    }
    const pointer = (existing.filePointer as DisplayFilePointer | null) ?? entry.filePointer;
    return { id: existing.id, created: false, pointer };
  }
  const message = await createMessage({
    agentId: ctx.agent.id,
    text: caption,
    role: 'ASSISTANT',
    metadata: {
      source: 'display',
      idempotencyKey: plan.idempotencyKey,
      display: {
        placement: 'inline',
        kind: 'media',
        media_kind: entry.kind,
        canonical_id: canonicalId,
        conversation: plan.conversation,
        sha256: entry.sha256,
        mime_type: entry.mimeType,
        ...(caption ? { caption } : {}),
      },
      requestingAgent: ctx.requesting,
      // The media is shown to the user; the caller's model gets the tool
      // result instead, so this row never splits a tool_use / tool_result pair.
      excludeFromModel: true,
      ...plan.metadata,
    },
    filePointer: entry.filePointer,
  });
  log.info('Displayed media', {
    agent_id: ctx.agent.id,
    message_id: message.id,
    canonical_id: canonicalId,
    conversation: plan.conversation,
    sha256: entry.sha256,
    kind: entry.kind,
    mime_type: entry.mimeType,
    size_bytes: entry.sizeBytes,
    file_count: entry.filePointer.bundle?.file_count ?? 1,
    via: ctx.requesting.kind,
  });
  const pointer = (message.filePointer as DisplayFilePointer | null) ?? entry.filePointer;
  return { id: message.id, created: message.id === messageId, pointer };
}

export async function postInline(
  ctx: ToolContext,
  entry: PreparedItem,
  caption: string
): Promise<DisplayItemResult> {
  const canonicalId = displayCanonicalId(canonicalScope(ctx), entry.sha256);
  // Sequential: the code agent's own row first, then the parent's.
  const rows: Awaited<ReturnType<typeof postRow>>[] = [];
  for (const plan of displayRowPlans(ctx, entry.sha256)) {
    rows.push(await postRow(ctx, entry, caption, canonicalId, plan));
  }
  const [own] = rows;
  return {
    ...itemResult(entry, own.created ? 'posted' : 'duplicate', own.id, own.pointer),
    canonical_id: canonicalId,
    ...(rows.length > 1 ? { parent_message_id: rows[1].id } : {}),
  };
}
