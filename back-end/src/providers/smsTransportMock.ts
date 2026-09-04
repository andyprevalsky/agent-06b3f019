import { createHash } from 'node:crypto';

import { isBenchmarkAgent } from './benchmarkAgent';
import { createLogger } from './logger';

const log = createLogger('SmsTransportMock');

/** Local benchmark stacks fake Surge at the fetch boundary (`fetchCapture.ts`). */
export function isLocalBenchmarkSmsTransportMockEnabled(): boolean {
  return process.env.BLACKBOX_TEST_FAKE_SURGE === '1';
}

export function isLocalBenchmarkAgentPhoneMockEnabled(): boolean {
  return process.env.BLACKBOX_TEST_FAKE_AGENTPHONE === '1';
}

export function isLocalBenchmarkWhatsAppTransportMockEnabled(): boolean {
  return process.env.BLACKBOX_TEST_FAKE_WHATSAPP === '1';
}

/** Surge-style ids from captured supervisor transcripts (msg_01…). */
export function mockSurgeMessageId(seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 26);
  return `msg_01${digest}`;
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

export async function shouldMockBenchmarkSmsSend(agentId?: string | null): Promise<boolean> {
  if (agentId === undefined || agentId === null || agentId.trim() === '') return false;
  return isBenchmarkAgent(agentId);
}

export async function shouldMockBenchmarkWhatsAppSend(agentId?: string | null): Promise<boolean> {
  if (agentId === undefined || agentId === null || agentId.trim() === '') return false;
  return isBenchmarkAgent(agentId);
}

export async function buildMockSurgeSendResult(params: {
  phoneNumber: string;
  message: string;
  seed: string;
}): Promise<{
  success: true;
  messageSid: string;
  mocked: true;
  reason: 'benchmark_transport_mock';
}> {
  const messageSid = mockSurgeMessageId(params.seed);
  log.info('Mocked Surge SMS send for benchmark run', {
    messageSid,
    phone: params.phoneNumber.substring(0, 7) + '****',
    bodyChars: params.message.length,
  });
  return {
    success: true,
    messageSid,
    mocked: true,
    reason: 'benchmark_transport_mock',
  };
}

export function buildMockAgentPhoneSendResult(params: {
  fromNumber: string;
  toNumber: string;
  seed: string;
}) {
  const messageId = mockAgentPhoneMessageId(params.seed);
  log.info('Mocked AgentPhone SMS send for benchmark run', {
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
}): Promise<{
  success: true;
  messageSid: string;
  mocked: true;
  reason: 'benchmark_transport_mock';
}> {
  const messageSid = mockWhatsAppMessageId(params.seed);
  log.info('Mocked WhatsApp Cloud API send for benchmark run', {
    messageSid,
    phone: params.phoneNumber.substring(0, 7) + '****',
  });
  return {
    success: true,
    messageSid,
    mocked: true,
    reason: 'benchmark_transport_mock',
  };
}
