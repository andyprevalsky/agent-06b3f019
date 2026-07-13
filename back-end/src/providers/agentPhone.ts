import { createLogger } from './logger';

const log = createLogger('AgentPhone');

const DEFAULT_BASE_URL = 'https://api.agentphone.ai/v1';
const DEFAULT_COUNTRY = 'US';
const DEFAULT_AREA_CODE = '912';

export interface AgentPhoneNumber {
  agentId: string;
  numberId: string;
  phoneNumber: string;
}

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

function apiKey() {
  return process.env.AGENTPHONE_API_KEY?.trim() || '';
}

function baseUrl() {
  return (process.env.AGENTPHONE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function defaultAreaCode() {
  return process.env.AGENTPHONE_AREA_CODE?.trim() || DEFAULT_AREA_CODE;
}

export function isAgentPhoneConfigured() {
  return apiKey() !== '';
}

function authHeaders() {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
  };
}

async function parseJson(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function dataArray(value: Record<string, unknown>): Record<string, unknown>[] {
  const raw = value.data;
  return Array.isArray(raw) ? raw.map(asRecord) : [];
}

function samePhone(left: string | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  return left.replace(/\D/g, '') === right.replace(/\D/g, '');
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

async function createAgent(name: string) {
  const response = await fetch(`${baseUrl()}/agents`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, voiceMode: 'webhook' }),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    throw new Error(
      `AgentPhone agent creation failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`
    );
  }
  const id = typeof data.id === 'string' ? data.id : '';
  if (id === '') throw new Error('AgentPhone agent creation response missing id');
  return id;
}

async function createNumber(agentId: string, areaCode: string) {
  const response = await fetch(`${baseUrl()}/numbers`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      country: DEFAULT_COUNTRY,
      areaCode,
      agentId,
    }),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    throw new Error(
      `AgentPhone number creation failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  const id = typeof data.id === 'string' ? data.id : '';
  const phoneNumber = typeof data.phoneNumber === 'string' ? data.phoneNumber : '';
  if (id === '' || phoneNumber === '') {
    throw new Error('AgentPhone number creation response missing id or phoneNumber');
  }
  return { id, phoneNumber };
}

export async function createAgentPhoneNumber(params: {
  userId: string;
  agentName?: string | null;
  areaCode?: string | null;
}): Promise<AgentPhoneNumber | null> {
  if (!isAgentPhoneConfigured()) {
    log.warn('AGENTPHONE_API_KEY missing; agent phone creation skipped', {
      userId: params.userId,
    });
    return null;
  }

  const displayName = params.agentName?.trim() || 'Rose';
  const areaCode = params.areaCode?.trim() || defaultAreaCode();
  const agentId = await createAgent(displayName);
  const number = await createNumber(agentId, areaCode);

  return {
    agentId,
    numberId: number.id,
    phoneNumber: number.phoneNumber,
  };
}

export async function sendAgentPhoneMessage(params: {
  agentId?: string | null;
  numberId?: string | null;
  fromNumber?: string | null;
  toNumber: string;
  body: string;
}): Promise<AgentPhoneOutboundMessage> {
  if (!isAgentPhoneConfigured()) {
    throw new Error('AGENTPHONE_API_KEY is not configured');
  }

  const response = await fetch(`${baseUrl()}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      body: params.body,
      to_number: params.toNumber,
      ...(params.numberId
        ? { number_id: params.numberId }
        : params.fromNumber
          ? { from_number: params.fromNumber }
          : params.agentId
            ? { agent_id: params.agentId }
            : {}),
    }),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    throw new Error(
      `AgentPhone message send failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  const id = stringValue(data.id);
  const status = stringValue(data.status);
  const channel = stringValue(data.channel);
  const fromNumber = stringValue(data.from_number);
  const toNumber = stringValue(data.to_number);
  if (id === '' || status === '' || channel === '' || fromNumber === '' || toNumber === '') {
    throw new Error('AgentPhone message send response missing delivery receipt fields');
  }
  return {
    id,
    status,
    channel,
    fromNumber,
    toNumber,
    conversationId: stringValue(data.conversation_id) || null,
  };
}

export async function listInboundMessagesForNumber(params: {
  numberId?: string | null;
  phoneNumber?: string | null;
  since: Date;
  limit: number;
}): Promise<AgentPhoneInboundMessage[]> {
  if (!isAgentPhoneConfigured()) return [];
  const conversationsResponse = await fetch(`${baseUrl()}/conversations?limit=100&offset=0`, {
    headers: authHeaders(),
  });
  const conversationsData = await parseJson(conversationsResponse);
  if (!conversationsResponse.ok) {
    throw new Error(
      `AgentPhone conversations fetch failed: HTTP ${conversationsResponse.status} ${JSON.stringify(
        conversationsData
      ).slice(0, 300)}`
    );
  }

  const conversations = dataArray(conversationsData).filter((conversation) => {
    const conversationNumberId = stringValue(conversation.phoneNumberId);
    const conversationNumber = stringValue(conversation.phoneNumber);
    return (
      (params.numberId ? conversationNumberId === params.numberId : false) ||
      samePhone(conversationNumber, params.phoneNumber)
    );
  });

  const messages: AgentPhoneInboundMessage[] = [];
  for (const conversation of conversations) {
    const conversationId = stringValue(conversation.id);
    if (conversationId === '') continue;
    const response = await fetch(
      `${baseUrl()}/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`,
      { headers: authHeaders() }
    );
    const data = await parseJson(response);
    if (!response.ok) {
      throw new Error(
        `AgentPhone conversation messages fetch failed: HTTP ${response.status} ${JSON.stringify(
          data
        ).slice(0, 300)}`
      );
    }

    for (const rawMessage of dataArray(data)) {
      const direction = stringValue(rawMessage.direction);
      const body = stringValue(rawMessage.body);
      const receivedAt = new Date(
        stringValue(rawMessage.receivedAt) || stringValue(rawMessage.createdAt)
      );
      if (direction !== 'inbound' || body === '' || Number.isNaN(receivedAt.getTime())) continue;
      if (receivedAt < params.since) continue;
      const to = stringValue(rawMessage.toNumber) || stringValue(rawMessage.to);
      if (params.phoneNumber && to && !samePhone(to, params.phoneNumber)) continue;
      messages.push({
        id: stringValue(rawMessage.id) || `${conversationId}:${receivedAt.toISOString()}:${body}`,
        from: stringValue(rawMessage.fromNumber) || stringValue(rawMessage.from),
        to,
        body,
        channel: stringValue(rawMessage.channel) || 'sms',
        receivedAt,
      });
    }
  }

  return messages
    .sort((left, right) => right.receivedAt.getTime() - left.receivedAt.getTime())
    .slice(0, params.limit);
}
