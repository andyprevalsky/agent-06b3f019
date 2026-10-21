/** Pure projection: one coordination group per human turn; raw rows remain untouched. */
import type { Message } from '../hooks';
import {
  eventTimeMs,
  parseAgentToAgentMessage,
  parsePinnedQuestion,
  type AgentToAgentMessage,
} from '../hooks/codeAgentContract';

export interface AgentExchange {
  key: string;
  a2a: AgentToAgentMessage;
  timestamps: number[];
}
export interface AgentExchangeGroup {
  key: string;
  leadId: string;
  exchanges: AgentExchange[];
}
export interface AgentExchangeGrouping {
  groupsByLeadId: Map<string, AgentExchangeGroup>;
  foldedIds: Set<string>;
}
export function groupAgentExchanges(messages: Message[]): AgentExchangeGrouping {
  const result: AgentExchangeGrouping = { groupsByLeadId: new Map(), foldedIds: new Set() };
  let turn = 'initial';
  let current: AgentExchangeGroup | null = null;
  let exchanges = new Map<string, AgentExchange>();
  for (const message of messages) {
    const a2a = parseAgentToAgentMessage(message);
    if (message.role === 'USER' && !a2a) {
      turn = message.message_id;
      current = null;
      exchanges = new Map();
    }
    if (!a2a || (a2a.from.kind !== 'agent' && a2a.to.kind !== 'agent')) continue;
    if (parsePinnedQuestion(message.metadata)) continue;
    const key = JSON.stringify([a2a.from.id, a2a.to.id, a2a.message_id]);
    if (!current) {
      current = { key: `${turn}:${key}`, leadId: message.message_id, exchanges: [] };
      result.groupsByLeadId.set(message.message_id, current);
    }
    result.foldedIds.add(message.message_id);
    let exchange = exchanges.get(key);
    if (!exchange) {
      exchange = { key, a2a, timestamps: [] };
      exchanges.set(key, exchange);
      current.exchanges.push(exchange);
    }
    const timestamp = eventTimeMs(message.timestamp);
    if (timestamp !== null && timestamp >= 0 && !exchange.timestamps.includes(timestamp)) {
      exchange.timestamps.push(timestamp);
    }
  }
  return result;
}

/** Missing/future timestamps never fabricate a rate or a recency label. */
export function exchangePace(group: AgentExchangeGroup, now: number): string | null {
  const timestamps = group.exchanges.map((exchange) => {
    const known = exchange.timestamps.filter((timestamp) => timestamp <= now);
    return known.length ? Math.min(...known) : null;
  });
  if (timestamps.some((timestamp) => timestamp === null)) return null;
  const known = timestamps as number[];
  if (!known.length) return null;
  const recent = known.filter((timestamp) => now - timestamp < 60000).length;
  const seconds = Math.max(0, Math.floor((now - Math.max(...known)) / 1000));
  const age =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m`
        : `${Math.floor(seconds / 3600)}h`;
  return `${recent} in last minute · last ${age} ago`;
}
