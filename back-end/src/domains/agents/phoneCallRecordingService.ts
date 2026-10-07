import { isAdminUser } from '../../utils/adminAccess';
import { createLogger } from '../../providers/logger';
import {
  VAPI_CALL_OPERATION_TYPE,
  agentIdFromOperationKey,
  downloadVapiCallRecording,
  findToolSideEffectOperationKey,
} from '../../providers/vapiRecordings';
import * as repo from './repo';

const log = createLogger('PhoneCallRecording');

export type PhoneCallRecordingResult =
  | { status: 200; body: Buffer; contentType: string }
  | { status: 401 | 403 | 404 | 502; error: string };

export async function getPhoneCallRecording(params: {
  agentId: string;
  callId: string;
  requesterUserId?: string;
  isInternal?: boolean;
}): Promise<PhoneCallRecordingResult> {
  const { agentId, callId, requesterUserId, isInternal } = params;
  if (agentId === '' || callId === '') {
    return { status: 404, error: 'Agent or call not found' };
  }

  const agent = await repo.findAgentById(agentId);
  if (agent === null) {
    return { status: 404, error: 'Agent not found' };
  }
  const canInspect =
    isInternal === true ||
    requesterUserId === undefined ||
    agent.userId === requesterUserId ||
    isAdminUser(requesterUserId);
  if (!canInspect) {
    return { status: 404, error: 'Agent not found' };
  }

  const operationKey = await findToolSideEffectOperationKey(VAPI_CALL_OPERATION_TYPE, callId);
  const owningAgentId = agentIdFromOperationKey(operationKey ?? undefined);
  if (owningAgentId !== agentId) {
    return { status: 404, error: 'Call recording not found' };
  }

  try {
    const recording = await downloadVapiCallRecording(callId);
    if (recording === null) {
      return { status: 404, error: 'Call recording not found' };
    }
    return { status: 200, body: recording.body, contentType: recording.contentType };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to load phone call recording', { agentId, callId, error: message });
    if (message === 'Vapi not configured') {
      return { status: 502, error: 'Vapi not configured' };
    }
    return { status: 502, error: 'Failed to load call recording' };
  }
}
