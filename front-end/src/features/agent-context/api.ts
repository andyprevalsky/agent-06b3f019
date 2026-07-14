import {
  benchmarkAgentPreviewEnabled,
  getAgent,
  getBenchmarkAgentPreview,
  postMessage as postMessageAPI,
} from '@/lib/api';

export { benchmarkAgentPreviewEnabled };

/** Fetch agent detail and messages by agent ID. */
export async function fetchAgentDetail(agentId: string) {
  try {
    return await getAgent(agentId);
  } catch (error) {
    if (!benchmarkAgentPreviewEnabled()) {
      throw error;
    }
    return getBenchmarkAgentPreview(agentId);
  }
}

/** Post a user message to the given agent. */
export async function postAgentMessage(agentId: string, text: string) {
  return postMessageAPI(agentId, text);
}
