/**
 * send_message_to_user from a code-agent sandbox (FYI only: progress, results,
 * scorecards). Same row shape as the agents worker's send_message_to_user, so
 * the FE renders it the same way, including a pinned `inlineView`:
 *
 *   rose message "…" [--inline-view scorecard --props '{…}']
 *     └─ inline_view.view must be in the user's ACTIVE rose-ui.json `inline`
 *        map; the row pins that versionId (same rule as W1's agents-side
 *        resolve_user_ui_inline_view_activity), so later publishes never
 *        change a message already sent.
 *
 * Idempotent per (agent, idempotency_key): the CLI reuses one key across its
 * own retries, and the lifecycle dedupe returns the first row.
 */
import { createLogger } from '../../providers/logger';
import { createMessage } from '../../providers/messages';
import { findActiveUserUiVersion } from '../../providers/userUi/store';
import { randomUUID } from '../../providers/crypto';
import { INLINE_VIEW_MAX_PROPS_BYTES } from './config';
import { AgentToolsError, requestIdFor, sandboxRowMetadata, type ToolContext } from './service';
import type { MessageRequestBody } from './types';

const log = createLogger('AgentToolsMessage');

async function resolveInlineView(
  userId: string,
  raw: MessageRequestBody['inline_view']
): Promise<{ view: string; versionId: string; props: Record<string, unknown> } | null> {
  if (raw === undefined) return null;
  const props = raw.props ?? {};
  if (Buffer.byteLength(JSON.stringify(props), 'utf8') > INLINE_VIEW_MAX_PROPS_BYTES) {
    throw new AgentToolsError(
      400,
      `inline_view.props must be at most ${INLINE_VIEW_MAX_PROPS_BYTES} bytes of JSON`
    );
  }
  const active = await findActiveUserUiVersion(userId);
  if (active === null) {
    throw new AgentToolsError(
      400,
      'The user has no published Rose UI, so inline views are unavailable. Publish one with `rose-ui publish` first.'
    );
  }
  const inline = active.manifest.inline ?? {};
  if (!(raw.view in inline)) {
    const available = Object.keys(inline).sort().join(', ') || 'none';
    throw new AgentToolsError(
      400,
      `Inline view '${raw.view}' is not in the user's published Rose UI (available: ${available}).`
    );
  }
  return { view: raw.view, versionId: active.id, props };
}

export async function sendMessageToUser(
  ctx: ToolContext,
  body: MessageRequestBody
): Promise<{ message_id: string; inline_view: { view: string; versionId: string } | null }> {
  if (ctx.caller.kind !== 'code_agent') {
    throw new AgentToolsError(
      400,
      'Rose agents message the user with their own send_message_to_user tool'
    );
  }
  const inlineView = await resolveInlineView(ctx.agent.userId, body.inline_view);
  const key = body.idempotency_key ?? randomUUID();
  const message = await createMessage({
    agentId: ctx.agent.id,
    text: body.message,
    role: 'TOOL',
    metadata: {
      toolCallId: `agent-tools:${requestIdFor(ctx.agent.id, 'message', key)}`,
      toolName: 'send_message_to_user',
      toolStatus: 'FINISHED',
      title: `${ctx.requesting.label}: FYI for User`,
      workflowGeneration: ctx.workflowGeneration,
      isUserAttentionMessage: true,
      attentionMessage: body.message,
      sendMessageToUser: { isQuestion: false, attentionKind: 'info', isWaitingForUser: false },
      ...(inlineView ? { inlineView } : {}),
      requestingAgent: ctx.requesting,
      ...sandboxRowMetadata(ctx),
    },
  });
  log.info('Sandbox message to user', {
    agent_id: ctx.agent.id,
    message_id: message.id,
    inline_view: inlineView?.view ?? null,
    provider: ctx.requesting.provider,
  });
  return {
    message_id: message.id,
    inline_view: inlineView ? { view: inlineView.view, versionId: inlineView.versionId } : null,
  };
}
