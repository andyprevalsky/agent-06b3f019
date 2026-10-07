import { VAPI_BASE_URL } from './config';
import { createLogger } from '../../providers/logger';
import { archiveBytes, archiveJson } from '../../providers/traceArchive';
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
