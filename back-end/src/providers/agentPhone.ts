import { createLogger } from './logger';
import {
  buildMockAgentPhoneNumber,
  isLocalBenchmarkAgentPhoneMockEnabled,
} from './smsTransportMock';
import { createHash } from './crypto';
import { runTransactionWithRetry } from './database';

const log = createLogger('AgentPhone');

const DEFAULT_BASE_URL = 'https://api.agentphone.ai/v1';
const DEFAULT_COUNTRY = 'US';
const DEFAULT_AREA_CODE = '912';
const CREATE_PHONE_TIMEOUT_MS = 10_000;
const RECONCILE_PAGE_SIZE = 100;
const MAX_RECONCILE_AGENTS = 10_000;

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

type AgentPhoneAgent = {
  id: string;
  description: string;
  numbers: Record<string, unknown>[];
};

class AgentPhoneHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'AgentPhoneHttpError';
  }
}

export class AgentPhoneProvisioningError extends Error {
  constructor(
    message: string,
    readonly emailFallbackSafe: boolean
  ) {
    super(message);
    this.name = 'AgentPhoneProvisioningError';
  }
}

export function isAgentPhoneEmailFallbackSafe(error: unknown): boolean {
  return error instanceof AgentPhoneProvisioningError && error.emailFallbackSafe;
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

function requestSignal() {
  return AbortSignal.timeout(CREATE_PHONE_TIMEOUT_MS);
}

function agentFromPayload(payload: Record<string, unknown>): AgentPhoneAgent | null {
  const id = stringValue(payload.id);
  if (id === '') return null;
  return {
    id,
    description: stringValue(payload.description),
    numbers: Array.isArray(payload.numbers) ? payload.numbers.map(asRecord) : [],
  };
}

function numberFromAgent(agent: AgentPhoneAgent): { id: string; phoneNumber: string } | null {
  for (const rawNumber of agent.numbers) {
    const id = stringValue(rawNumber.id);
    const phoneNumber = stringValue(rawNumber.phoneNumber);
    const status = stringValue(rawNumber.status);
    if (id !== '' && phoneNumber !== '' && (status === '' || status === 'active')) {
      return { id, phoneNumber };
    }
  }
  return null;
}

function markerForUser(userId: string) {
  return `rose-provisioning:${createHash('sha256').update(userId).digest('hex')}`;
}

function isConfirmedAgentCreateRejection(error: unknown) {
  return (
    error instanceof AgentPhoneHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 429].includes(error.status)
  );
}

async function createAgent(name: string, description: string): Promise<AgentPhoneAgent> {
  const response = await fetch(`${baseUrl()}/agents`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, description, voiceMode: 'webhook' }),
    signal: requestSignal(),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    throw new AgentPhoneHttpError(
      `AgentPhone agent creation failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`,
      response.status
    );
  }
  const agent = agentFromPayload(data);
  if (agent === null) throw new Error('AgentPhone agent creation response missing id');
  return agent;
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
    signal: requestSignal(),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    throw new AgentPhoneHttpError(
      `AgentPhone number creation failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`,
      response.status
    );
  }

  const id = typeof data.id === 'string' ? data.id : '';
  const phoneNumber = typeof data.phoneNumber === 'string' ? data.phoneNumber : '';
  if (id === '' || phoneNumber === '') {
    throw new Error('AgentPhone number creation response missing id or phoneNumber');
  }
  return { id, phoneNumber };
}

async function findAgentByMarker(marker: string): Promise<AgentPhoneAgent | null> {
  const matches: AgentPhoneAgent[] = [];
  let offset = 0;
  let scanComplete = false;
  while (offset < MAX_RECONCILE_AGENTS) {
    const response = await fetch(
      `${baseUrl()}/agents?limit=${RECONCILE_PAGE_SIZE}&offset=${offset}`,
      { headers: authHeaders(), signal: requestSignal() }
    );
    const data = await parseJson(response);
    if (!response.ok) {
      throw new Error(
        `AgentPhone reconciliation failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`
      );
    }
    const page = dataArray(data);
    for (const payload of page) {
      const agent = agentFromPayload(payload);
      if (agent?.description === marker) matches.push(agent);
    }
    const total =
      typeof data.total === 'number' && Number.isFinite(data.total) && data.total >= 0
        ? data.total
        : null;
    offset += page.length;
    if (
      page.length === 0 ||
      page.length < RECONCILE_PAGE_SIZE ||
      (total !== null && offset >= total)
    ) {
      scanComplete = true;
      break;
    }
  }
  if (!scanComplete) {
    throw new Error(
      `AgentPhone reconciliation exceeded the ${MAX_RECONCILE_AGENTS}-agent scan bound`
    );
  }
  if (matches.length > 1) {
    throw new Error(`AgentPhone reconciliation found ${matches.length} resources for one marker`);
  }
  return matches[0] ?? null;
}

async function getAgent(agentId: string): Promise<AgentPhoneAgent> {
  const response = await fetch(`${baseUrl()}/agents/${encodeURIComponent(agentId)}`, {
    headers: authHeaders(),
    signal: requestSignal(),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    throw new Error(
      `AgentPhone agent reconciliation failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`
    );
  }
  const agent = agentFromPayload(data);
  if (agent === null) throw new Error('AgentPhone reconciliation response missing agent id');
  return agent;
}

async function deleteAgent(agentId: string): Promise<void> {
  const response = await fetch(`${baseUrl()}/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
    headers: authHeaders(),
    signal: requestSignal(),
  });
  if (!response.ok && response.status !== 404) {
    const data = await parseJson(response);
    throw new Error(
      `AgentPhone cleanup failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`
    );
  }
}

async function provisionAgentPhoneNumber(params: {
  userId: string;
  agentName?: string | null;
  areaCode?: string | null;
}): Promise<AgentPhoneNumber> {
  const displayName = params.agentName?.trim() || 'Rose';
  const areaCode = params.areaCode?.trim() || defaultAreaCode();
  const marker = markerForUser(params.userId);
  let agent: AgentPhoneAgent;
  try {
    agent = await createAgent(displayName, marker);
  } catch (error) {
    if (isConfirmedAgentCreateRejection(error)) {
      throw new AgentPhoneProvisioningError(
        `AgentPhone rejected agent creation: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }
    try {
      const recovered = await findAgentByMarker(marker);
      if (recovered === null) {
        throw new Error('no exact provisioning marker was visible after a complete scan');
      }
      agent = recovered;
    } catch (reconcileError) {
      throw new AgentPhoneProvisioningError(
        `AgentPhone agent creation is uncertain; reconciliation failed: ${
          reconcileError instanceof Error ? reconcileError.message : String(reconcileError)
        }`,
        false
      );
    }
  }

  const recoveredNumber = numberFromAgent(agent);
  if (recoveredNumber) {
    return {
      agentId: agent.id,
      numberId: recoveredNumber.id,
      phoneNumber: recoveredNumber.phoneNumber,
    };
  }

  let number: { id: string; phoneNumber: string };
  try {
    number = await createNumber(agent.id, areaCode);
  } catch (createError) {
    try {
      const reconciledAgent = await getAgent(agent.id);
      const reconciledNumber = numberFromAgent(reconciledAgent);
      if (reconciledNumber) {
        return {
          agentId: agent.id,
          numberId: reconciledNumber.id,
          phoneNumber: reconciledNumber.phoneNumber,
        };
      }
      await deleteAgent(agent.id);
    } catch (reconcileError) {
      throw new AgentPhoneProvisioningError(
        `AgentPhone number creation is uncertain; reconciliation or cleanup failed: ${
          reconcileError instanceof Error ? reconcileError.message : String(reconcileError)
        }`,
        false
      );
    }
    throw new AgentPhoneProvisioningError(
      `AgentPhone number creation failed and provider-agent cleanup was confirmed: ${
        createError instanceof Error ? createError.message : String(createError)
      }`,
      true
    );
  }

  return {
    agentId: agent.id,
    numberId: number.id,
    phoneNumber: number.phoneNumber,
  };
}

export async function createAgentPhoneNumber(params: {
  userId: string;
  agentName?: string | null;
  areaCode?: string | null;
}): Promise<AgentPhoneNumber | null> {
  if (isLocalBenchmarkAgentPhoneMockEnabled()) {
    const number = buildMockAgentPhoneNumber(params.userId);
    log.info('Mocked AgentPhone number provisioning for benchmark run', {
      userId: params.userId,
      agentId: number.agentId,
      numberId: number.numberId,
    });
    return number;
  }

  if (!isAgentPhoneConfigured()) {
    log.warn('AGENTPHONE_API_KEY missing; agent phone creation skipped', {
      userId: params.userId,
    });
    return null;
  }

  // Provider creation has no idempotency key. Serialize by user across backend
  // replicas and persist the provider identity before releasing the lock. A
  // waiting replica therefore reuses the exact resource instead of creating a
  // second one. Marker pagination is reserved for an uncertain create outcome;
  // scanning a large provider account on every ordinary signup is neither a
  // scalable nor a reliable absence proof.
  return runTransactionWithRetry(
    async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`agentphone-provision:${params.userId}`}))
      `;
      const existing = await transaction.agentIdentity.findUniqueOrThrow({
        where: { userId: params.userId },
        select: {
          phone: true,
          phoneProviderAgentId: true,
          phoneProviderNumberId: true,
        },
      });
      if (
        existing.phone !== null &&
        existing.phoneProviderAgentId !== null &&
        existing.phoneProviderNumberId !== null
      ) {
        return {
          agentId: existing.phoneProviderAgentId,
          numberId: existing.phoneProviderNumberId,
          phoneNumber: existing.phone,
        };
      }

      const provisioned = await provisionAgentPhoneNumber(params);
      await transaction.agentIdentity.update({
        where: { userId: params.userId },
        data: {
          phone: provisioned.phoneNumber,
          phoneProvider: 'agentphone',
          phoneProviderAgentId: provisioned.agentId,
          phoneProviderNumberId: provisioned.numberId,
        },
      });
      return provisioned;
    },
    { maxWait: 30_000, timeout: 120_000 }
  );
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
