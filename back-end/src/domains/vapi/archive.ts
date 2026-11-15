import { VAPI_BASE_URL } from './config';
import { createLogger } from '../../providers/logger';
import { archiveBytes, archiveJson } from '../../providers/traceArchive';
import { resolveArchiveRoot } from '../../providers/archiveRootResolver';
import { userArchiveRoot } from '../../providers/llmArchiveRecord';
import { getEphemeral, putEphemeral } from '../../providers/sharedState';
import {
  VAPI_CALL_OPERATION_TYPE,
  agentIdFromOperationKey,
  downloadVapiCallRecording,
  findToolSideEffectOperationKey,
} from '../../providers/vapiRecordings';

const log = createLogger('VapiArchive');
export { agentIdFromOperationKey };

export type VapiPollExchange = {
  request: {
    method: 'GET';
    url: string;
    startedAt: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    receivedAt: string;
    durationMs: number;
  };
};

const VAPI_POLL_DIAGNOSTIC_HEADERS = [
  'age',
  'cache-control',
  'cf-cache-status',
  'date',
  'etag',
  'last-modified',
  'server',
  'via',
  'x-cache',
] as const;

export function buildVapiPollExchange(
  requestUrl: string,
  startedAt: Date,
  receivedAt: Date,
  response: Response
): VapiPollExchange {
  const headers = Object.fromEntries(
    VAPI_POLL_DIAGNOSTIC_HEADERS.flatMap((name) => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value]];
    })
  );
  return {
    request: {
      method: 'GET',
      url: requestUrl,
      startedAt: startedAt.toISOString(),
    },
    response: {
      status: response.status,
      headers,
      receivedAt: receivedAt.toISOString(),
      durationMs: Math.max(0, receivedAt.getTime() - startedAt.getTime()),
    },
  };
}

export async function agentIdForCallId(callId: string): Promise<string | null> {
  const operationKey = await findToolSideEffectOperationKey(VAPI_CALL_OPERATION_TYPE, callId);
  return agentIdFromOperationKey(operationKey ?? undefined);
}

/**
 * Archive root of a voice call:
 *   idempotency key names the agent ─► that agent tree's ROOT (busId ?? id)
 *   no key, caller user known        ─► the documented per-user root `user-<userId>`
 * Calls placed without either have no owner to file under (logged loudly).
 */
export async function archiveRootForCall(call: {
  operationKey?: string;
  userId?: string;
}): Promise<string | null> {
  const agentId = agentIdFromOperationKey(call.operationKey);
  if (agentId !== null) return resolveArchiveRoot(agentId);
  if (call.userId !== undefined && call.userId !== '') return userArchiveRoot(call.userId);
  log.error('Vapi call has no agent or user to archive under', {
    operation_key: call.operationKey ?? null,
  });
  return null;
}

const CALL_ROOT_NAMESPACE = 'vapi-call-archive-root';
/** Polls, transcripts and recordings of a call arrive for days after placement. */
const CALL_ROOT_TTL_MS = 30 * 24 * 60 * 60_000;

/** Remember where a call's later polls/transcript/recording are filed (one row per call). */
export async function rememberCallArchiveRoot(callId: string, rootAgentId: string | null) {
  if (rootAgentId === null || callId === '') return;
  await putEphemeral(CALL_ROOT_NAMESPACE, callId, { rootAgentId }, CALL_ROOT_TTL_MS);
}

/** Root for a call id: recorded at placement, else the idempotency ledger's agent → root. */
export async function archiveRootForCallId(callId: string): Promise<string | null> {
  const remembered = await getEphemeral<{ rootAgentId?: string }>(CALL_ROOT_NAMESPACE, callId);
  if (typeof remembered?.rootAgentId === 'string') return remembered.rootAgentId;
  const agentId = await agentIdForCallId(callId);
  return agentId === null ? null : resolveArchiveRoot(agentId);
}

export async function archiveVapiJson(
  rootAgentId: string | null,
  path: string,
  value: unknown
): Promise<void> {
  if (rootAgentId === null) return;
  await archiveJson({
    rootAgentId,
    objectPath: `provider/vapi/${path}`,
    value,
  });
}

export async function archiveVapiRecording(
  rootAgentId: string | null,
  callId: string,
  _recordingUrl?: unknown
): Promise<void> {
  if (rootAgentId === null || callId === '') return;
  try {
    const recording = await downloadVapiCallRecording(callId);
    if (recording === null) return;
    await archiveBytes({
      rootAgentId,
      objectPath: `media/vapi/${callId}.recording`,
      body: recording.body,
      contentType: recording.contentType,
      compress: false,
    });
  } catch (error) {
    log.warn('Failed to archive Vapi recording', {
      callId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function archiveVapiPollResult(
  callId: string,
  result: Record<string, unknown>,
  exchange?: VapiPollExchange
): Promise<void> {
  const rootAgentId = await archiveRootForCallId(callId);
  await archiveVapiJson(rootAgentId, `${callId}.poll.${Date.now()}.json.gz.enc`, {
    request: exchange?.request ?? { method: 'GET', url: `${VAPI_BASE_URL}/call/${callId}` },
    http: exchange?.response,
    response: result,
  });
  if (result.status === 'ended') {
    await archiveVapiJson(rootAgentId, `${callId}.terminal.json.gz.enc`, {
      transcript: result.transcript,
      analysis: result.analysis,
      summary: result.summary,
      structuredData:
        typeof result.analysis === 'object' && result.analysis !== null
          ? (result.analysis as Record<string, unknown>).structuredData
          : undefined,
      endedReason: result.endedReason,
      duration: result.duration,
      recordingUrl: result.recordingUrl,
    });
    await archiveVapiRecording(rootAgentId, callId, result.recordingUrl);
  }
}
