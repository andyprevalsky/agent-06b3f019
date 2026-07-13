import { VAPI_BASE_URL } from './config';
import { createLogger } from '../../providers/logger';
import { archiveBytes, archiveJson } from '../../providers/traceArchive';
import { findToolSideEffectOperationKey } from './repo';

const log = createLogger('VapiArchive');
const VAPI_CALL_OPERATION_TYPE = 'vapi.outbound_call';

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

export function agentIdFromOperationKey(operationKey?: string): string | null {
  if (operationKey === undefined) return null;
  const prefix = `${VAPI_CALL_OPERATION_TYPE}:`;
  if (!operationKey.startsWith(prefix)) return null;
  const rest = operationKey.slice(prefix.length);
  const agentId = rest.split(':')[0];
  return agentId !== undefined && agentId !== '' ? agentId : null;
}

async function agentIdForCallId(callId: string): Promise<string | null> {
  const operationKey = await findToolSideEffectOperationKey(VAPI_CALL_OPERATION_TYPE, callId);
  return agentIdFromOperationKey(operationKey ?? undefined);
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
  recordingUrl: unknown
): Promise<void> {
  if (rootAgentId === null || typeof recordingUrl !== 'string' || recordingUrl === '') return;
  try {
    const response = await fetch(recordingUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return;
    const arrayBuffer = await response.arrayBuffer();
    const responseContentType = response.headers.get('content-type');
    const contentType =
      responseContentType !== null && responseContentType !== ''
        ? responseContentType
        : 'audio/mpeg';
    await archiveBytes({
      rootAgentId,
      objectPath: `media/vapi/${callId}.recording`,
      body: Buffer.from(arrayBuffer),
      contentType,
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
  const rootAgentId = await agentIdForCallId(callId);
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
