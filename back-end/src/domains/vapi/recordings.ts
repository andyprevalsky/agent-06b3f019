import { VAPI_BASE_URL, VAPI_PRIVATE_KEY } from './config';
import { createLogger } from '../../providers/logger';

const log = createLogger('VapiRecordings');

export const VAPI_RECORDING_ARTIFACT_PATHS = ['mono-recording', 'stereo-recording'] as const;

export type VapiRecordingBytes = {
  body: Buffer;
  contentType: string;
};

export function firstPartyPhoneRecordingPath(agentId: string, callId: string): string {
  return `/api/agents/${agentId}/phone-calls/${callId}/recording`;
}

export function rewriteEndedCallRecordingUrl(
  result: Record<string, unknown>,
  callId: string,
  agentId: string | null
): Record<string, unknown> {
  if (result.status !== 'ended' || agentId === null || agentId === '') return result;
  return {
    ...result,
    recordingUrl: firstPartyPhoneRecordingPath(agentId, callId),
  };
}

function getVapiPrivateKey(): string {
  const vapiPrivateKey = VAPI_PRIVATE_KEY;
  if (vapiPrivateKey === undefined || vapiPrivateKey === '') {
    throw new Error('Vapi not configured');
  }
  return vapiPrivateKey;
}

/**
 * Download a call recording through Vapi's authenticated artifact API.
 *
 * Provider `recordingUrl` values (including `*.r2.cloudflarestorage.com/hipaa-recordings/...`)
 * are private bucket objects and are not browser-playable. Vapi documents
 * `GET /call/{id}/mono-recording` as the retrieval path: it 302s to a short-lived
 * signed URL. Native fetch follows that redirect without forwarding the Bearer
 * token to R2.
 */
export async function downloadVapiCallRecording(
  callId: string
): Promise<VapiRecordingBytes | null> {
  const vapiPrivateKey = getVapiPrivateKey();
  for (const artifact of VAPI_RECORDING_ARTIFACT_PATHS) {
    const url = `${VAPI_BASE_URL}/call/${callId}/${artifact}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${vapiPrivateKey}` },
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        log.warn('Vapi recording artifact not available', {
          callId,
          artifact,
          status: response.status,
        });
        continue;
      }
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength === 0) continue;
      const responseContentType = response.headers.get('content-type');
      const contentType =
        responseContentType !== null &&
        responseContentType !== '' &&
        !responseContentType.includes('application/json') &&
        !responseContentType.includes('text/html')
          ? responseContentType
          : 'audio/wav';
      return { body: Buffer.from(arrayBuffer), contentType };
    } catch (error) {
      log.warn('Vapi recording artifact download failed', {
        callId,
        artifact,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}
