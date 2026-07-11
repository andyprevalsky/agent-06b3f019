import { createMessage } from '../../providers/messages';
import { sendSms } from '../../providers/smsQueue';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import type { CreateAttentionRequestInput, Gate } from './types';

const log = createLogger('AttentionRequests');
const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function extractGate(metadata: unknown): unknown {
  if (metadata !== null && typeof metadata === 'object' && 'gate' in metadata) {
    return (metadata as { gate?: unknown }).gate;
  }
  return undefined;
}

function renderGateSms(gate: Gate): string {
  if (gate.action.kind === 'link') {
    return `${gate.presentation.title}: ${gate.action.url}`;
  }
  const token = gate.action.tokens[0] ?? 'YES';
  return `${gate.presentation.title} Reply ${token} to continue.`;
}

export async function maybeDispatchGateSms(
  data: CreateAttentionRequestInput,
  gate: Gate
): Promise<string | undefined> {
  const agent = await repo.findAgentSource(data.agentId);
  if (agent?.source !== 'SMS') return undefined;
  const phone = await repo.findUserPhone(data.userId);
  if (phone === null || phone === '') return undefined;
  const body = renderGateSms(gate);
  try {
    await sendSms(phone, body);
  } catch (error) {
    log.error('Failed to dispatch gate SMS', { agent_id: data.agentId, error: errMsg(error) });
  }
  return body;
}

export async function emitGateMessage(
  agentId: string,
  gate: Gate,
  requestId: string
): Promise<void> {
  try {
    await createMessage({
      agentId,
      role: 'TOOL',
      text: gate.presentation.title,
      metadata: {
        gate,
        attentionRequestId: requestId,
        toolName: 'gate',
        toolStatus: 'IN_PROGRESS',
        toolCallId: requestId,
      },
    });
  } catch (error) {
    log.error('Failed to emit gate message', { agent_id: agentId, error: errMsg(error) });
  }
}

export function toCreateResult(
  request: { id: string; createdAt: Date; metadata: unknown },
  deduped: boolean,
  gateSms?: string
) {
  return {
    id: request.id,
    created_at: request.createdAt,
    metadata: request.metadata,
    deduped,
    ...(gateSms !== undefined ? { gateSms } : {}),
  };
}
