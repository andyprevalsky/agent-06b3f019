import { createHash } from 'node:crypto';

import { isBenchmarkAgent } from './benchmarkAgent';
import { createLogger } from './logger';
import { isBenchmarkRuntime } from './plannerMemoryDefaults';
import { SMS_MAX_BODY_CHARACTERS } from './smsDeliveryContract';

const log = createLogger('SmsTransportMock');

/** Local benchmark stacks fake Surge at the fetch boundary (`fetchCapture.ts`). */
export function isLocalBenchmarkSmsTransportMockEnabled(): boolean {
  return process.env.BLACKBOX_TEST_FAKE_SURGE === '1';
}

export function isLocalBenchmarkAgentPhoneMockEnabled(): boolean {
  return (
    process.env.BLACKBOX_TEST_FAKE_AGENTPHONE === '1' &&
    (process.env.NODE_ENV !== 'production' || process.env.BENCHMARK_ISOLATED_RUN === 'true')
  );
}

export function isLocalBenchmarkWhatsAppTransportMockEnabled(): boolean {
  return process.env.BLACKBOX_TEST_FAKE_WHATSAPP === '1';
}

/** Surge-style ids from captured supervisor transcripts (msg_01…). */
export function mockSurgeMessageId(seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 26);
  return `msg_01${digest}`;
}

/** Captured Surge responses, including the real SMS body validation contract. */
export function buildMockSurgeFetchResponse(requestBody: string | null): Response {
  const sms = JSON.parse(requestBody ?? '{}') as { body?: unknown };
  for (const status of [400, 401, 403, 404, 429]) {
    if (typeof sms.body === 'string' && sms.body.includes(`__BLACKBOX_SURGE_${status}__`)) {
      return new Response(JSON.stringify({ error: 'body rejected by provider' }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
  }
  if (
    typeof sms.body === 'string' &&
    (sms.body.length > SMS_MAX_BODY_CHARACTERS || sms.body.includes('__BLACKBOX_SURGE_422__'))
  ) {
    return new Response(
      JSON.stringify({
        error: {
          message: 'Could not perform the request with the provided parameters.',
          type: 'validation_error',
          detail: {
            body: [
              sms.body.length > SMS_MAX_BODY_CHARACTERS
                ? `should be at most ${SMS_MAX_BODY_CHARACTERS} character(s)`
                : 'body rejected by provider',
            ],
          },
        },
      }),
      { status: 422, headers: { 'content-type': 'application/json' } }
    );
  }
  if (requestBody?.includes('__BLACKBOX_SURGE_THROW__')) {
    throw new Error('blackbox fake Surge network failure');
  }
  if (requestBody?.includes('__BLACKBOX_SURGE_502__')) {
    return new Response('blackbox fake Surge upstream unavailable', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'text/plain' },
    });
  }
  // Stable ids depend on the payload, never on unrelated capture traffic.
  return new Response(JSON.stringify({ id: mockSurgeMessageId(`capture:${requestBody ?? ''}`) }), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

export function mockAgentPhoneMessageId(seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return `ap_msg_${digest}`;
}

export function buildMockAgentPhoneNumber(userId: string) {
  const digest = createHash('sha256').update(userId).digest('hex');
  const subscriber = (parseInt(digest.slice(0, 8), 16) % 10_000_000).toString().padStart(7, '0');
  return {
    agentId: `ap_agent_${digest.slice(0, 12)}`,
    numberId: `ap_num_${digest.slice(12, 24)}`,
    phoneNumber: `+1555${subscriber}`,
  };
}

/** Meta Cloud API message ids (`wamid.…`) from captured webhook transcripts. */
export function mockWhatsAppMessageId(seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 16);
  return `wamid.${digest}`;
}

export type MessagingTransport = 'surge' | 'linq' | 'whatsapp' | 'agentphone' | 'twilio-verify';
export type MessagingMockReason = 'benchmark_agent' | 'non_production_runtime';

const FETCH_FAKE_FLAGS: Record<MessagingTransport, string> = {
  surge: 'BLACKBOX_TEST_FAKE_SURGE',
  linq: 'BLACKBOX_TEST_FAKE_LINQ',
  whatsapp: 'BLACKBOX_TEST_FAKE_WHATSAPP',
  agentphone: 'BLACKBOX_TEST_FAKE_AGENTPHONE',
  'twilio-verify': 'BLACKBOX_TEST_FAKE_TWILIO',
};

let messagingFetchFakesInstalled = false;

/** Called by `installFetchCapture()`; the fake flags mean nothing until it runs. */
export function markMessagingFetchFakesInstalled(): void {
  messagingFetchFakesInstalled = true;
}

export function isMessagingTransportFakedAtFetchBoundary(
  transport: MessagingTransport,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return messagingFetchFakesInstalled && env[FETCH_FAKE_FLAGS[transport]] === '1';
}

/**
 * Only the production backend may text real phones. Benchmark stacks and Render
 * PR previews can never opt in; any other process can with
 * ALLOW_LIVE_MESSAGING=1 (deliberate local testing, or a unit test that stubs fetch).
 */
export function isLiveMessagingRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isBenchmarkRuntime(env)) return false;
  if (env.IS_PULL_REQUEST === 'true') return false;
  if (env.ALLOW_LIVE_MESSAGING === '1') return true;
  return env.NODE_ENV === 'production' && env.BLACKBOX_TEST_CAPTURE_OUTBOUND !== '1';
}

/**
 * Null means the caller may hand the request to `fetch`: either the runtime is
 * live, or the installed fetch-capture fake owns this provider's boundary.
 * A benchmark agent is mocked in every runtime; its lookup error propagates so
 * callers fail closed instead of texting.
 */
export async function shouldMockMessagingSend(
  transport: MessagingTransport,
  agentId?: string | null
): Promise<MessagingMockReason | null> {
  if (
    agentId !== undefined &&
    agentId !== null &&
    agentId.trim() !== '' &&
    (await isBenchmarkAgent(agentId))
  ) {
    return 'benchmark_agent';
  }
  if (isMessagingTransportFakedAtFetchBoundary(transport)) return null;
  return isLiveMessagingRuntime() ? null : 'non_production_runtime';
}

/** Archive markers for a mocked send; `benchmark_transport_mock` stays benchmark-only. */
export function transportMockArchiveContext(reason: MessagingMockReason): {
  benchmark_transport_mock: boolean;
  transport_mock_reason: MessagingMockReason;
} {
  return {
    benchmark_transport_mock: reason === 'benchmark_agent',
    transport_mock_reason: reason,
  };
}

export async function buildMockSurgeSendResult(params: {
  phoneNumber: string;
  message: string;
  seed: string;
  reason: MessagingMockReason;
}): Promise<{
  success: true;
  messageSid: string;
  mocked: true;
  reason: MessagingMockReason;
}> {
  const messageSid = mockSurgeMessageId(params.seed);
  log.info('Mocked Surge SMS send', {
    reason: params.reason,
    messageSid,
    phone: params.phoneNumber.substring(0, 7) + '****',
    bodyChars: params.message.length,
  });
  return {
    success: true,
    messageSid,
    mocked: true,
    reason: params.reason,
  };
}

export function buildMockAgentPhoneSendResult(params: {
  fromNumber: string;
  toNumber: string;
  seed: string;
  reason: MessagingMockReason;
}) {
  const messageId = mockAgentPhoneMessageId(params.seed);
  log.info('Mocked AgentPhone SMS send', {
    reason: params.reason,
    messageId,
    from: params.fromNumber.substring(0, 7) + '****',
    to: params.toNumber.substring(0, 7) + '****',
  });
  return {
    id: messageId,
    status: 'sent',
    channel: 'sms',
    fromNumber: params.fromNumber,
    toNumber: params.toNumber,
    conversationId: `conv_${messageId.slice(-8)}`,
  };
}

export async function buildMockWhatsAppSendResult(params: {
  phoneNumber: string;
  seed: string;
  reason: MessagingMockReason;
}): Promise<{
  success: true;
  messageSid: string;
  mocked: true;
  reason: MessagingMockReason;
}> {
  const messageSid = mockWhatsAppMessageId(params.seed);
  log.info('Mocked WhatsApp Cloud API send', {
    reason: params.reason,
    messageSid,
    phone: params.phoneNumber.substring(0, 7) + '****',
  });
  return {
    success: true,
    messageSid,
    mocked: true,
    reason: params.reason,
  };
}
