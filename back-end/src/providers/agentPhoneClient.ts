const DEFAULT_BASE_URL = 'https://api.agentphone.ai/v1';

export interface AgentPhoneInboundMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  channel: string;
  receivedAt: Date;
}

export interface AgentPhoneOutboundMessage {
  id: string;
  status: string;
  channel: string;
  fromNumber: string;
  toNumber: string;
  conversationId: string | null;
}

export function apiKey() {
  return process.env.AGENTPHONE_API_KEY?.trim() || '';
}

export function baseUrl() {
  return (process.env.AGENTPHONE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Isolated test stacks may reach the live API only with the dedicated test account. */
export function isTestStackUsingNonTestAccount() {
  if (process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND !== '1') return false;
  if (baseUrl() !== DEFAULT_BASE_URL) return false;
  return apiKey() !== (process.env.AGENTPHONE_TEST_API_KEY?.trim() || '');
}

export function isAgentPhoneConfigured() {
  return apiKey() !== '';
}

export function authHeaders() {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
  };
}

export async function parseJson(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function dataArray(value: Record<string, unknown>): Record<string, unknown>[] {
  const raw = value.data;
  return Array.isArray(raw) ? raw.map(asRecord) : [];
}

export function samePhone(left: string | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  return left.replace(/\D/g, '') === right.replace(/\D/g, '');
}

export function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}
