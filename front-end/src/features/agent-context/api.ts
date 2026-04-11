import { getAgent, postMessage as postMessageAPI } from '@/lib/api';

/** Fetch agent detail and messages by agent ID. */
export async function fetchAgentDetail(agentId: string) {
  return getAgent(agentId);
}

/** Post a user message to the given agent. */
export async function postAgentMessage(agentId: string, text: string) {
  return postMessageAPI(agentId, text);
}
