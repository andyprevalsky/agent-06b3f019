import {
  authHeaders,
  baseUrl,
  dataArray,
  isAgentPhoneConfigured,
  parseJson,
  samePhone,
  stringValue,
  type AgentPhoneInboundMessage,
  type AgentPhoneOutboundMessage,
} from './agentPhoneClient';

const MESSAGING_TIMEOUT_MS = 10_000;
const CONVERSATION_PAGE_SIZE = 100;
const MAX_CONVERSATION_PAGES = 100;

function messagingDeadlineAt(): number {
  return Date.now() + MESSAGING_TIMEOUT_MS;
}

function messagingSignal(requestDeadlineAt: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, requestDeadlineAt - Date.now()));
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

  const requestDeadlineAt = messagingDeadlineAt();
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
    signal: messagingSignal(requestDeadlineAt),
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

export type AgentPhoneInboundListParams = {
  since: Date;
  limit: number;
} & (
  | { numberId: string; phoneNumber?: string | null }
  | { phoneNumber: string; numberId?: string | null }
);

function inboundSelector(params: AgentPhoneInboundListParams): {
  numberId: string;
  phoneNumber: string;
} {
  const numberId = params.numberId?.trim() ?? '';
  const phoneNumber = params.phoneNumber?.trim() ?? '';
  if (numberId === '' && phoneNumber === '') {
    throw new Error('AgentPhone inbound list requires numberId or phoneNumber');
  }
  return { numberId, phoneNumber };
}

export async function listInboundMessagesForNumber(
  params: AgentPhoneInboundListParams
): Promise<AgentPhoneInboundMessage[]> {
  if (!isAgentPhoneConfigured()) return [];
  const selector = inboundSelector(params);
  const requestDeadlineAt = messagingDeadlineAt();
  const conversations: Record<string, unknown>[] = [];
  for (let page = 0; page < MAX_CONVERSATION_PAGES; page += 1) {
    const offset = page * CONVERSATION_PAGE_SIZE;
    const conversationsResponse = await fetch(
      `${baseUrl()}/conversations?limit=${CONVERSATION_PAGE_SIZE}&offset=${offset}`,
      {
        headers: authHeaders(),
        signal: messagingSignal(requestDeadlineAt),
      }
    );
    const conversationsData = await parseJson(conversationsResponse);
    if (!conversationsResponse.ok) {
      throw new Error(
        `AgentPhone conversations fetch failed: HTTP ${conversationsResponse.status} ${JSON.stringify(
          conversationsData
        ).slice(0, 300)}`
      );
    }

    const pageRows = dataArray(conversationsData);
    const matches = pageRows.filter((conversation) => {
      const conversationNumberId = stringValue(conversation.phoneNumberId);
      const conversationNumber = stringValue(conversation.phoneNumber);
      return (
        (selector.numberId !== '' && conversationNumberId === selector.numberId) ||
        (selector.phoneNumber !== '' && samePhone(conversationNumber, selector.phoneNumber))
      );
    });
    conversations.push(...matches);
    if (pageRows.length === 0 || pageRows.length < CONVERSATION_PAGE_SIZE) {
      break;
    }
  }

  const messages: AgentPhoneInboundMessage[] = [];
  for (const conversation of conversations) {
    const conversationId = stringValue(conversation.id);
    if (conversationId === '') continue;
    const response = await fetch(
      `${baseUrl()}/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`,
      { headers: authHeaders(), signal: messagingSignal(requestDeadlineAt) }
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
