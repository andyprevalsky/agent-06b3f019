import {
  benchmarkAgentPreviewEnabled,
  getAgent,
  getBenchmarkAgentPreview,
  getBenchmarkSharedAgent,
  postMessage as postMessageAPI,
} from '@/lib/api';
import { isBenchmarkSharedView } from '@/lib/benchmarkShare';

export { benchmarkAgentPreviewEnabled };

/** Fetch agent detail and messages by agent ID. */
export async function fetchAgentDetail(agentId: string, signal?: AbortSignal) {
  if (isBenchmarkSharedView()) return getBenchmarkSharedAgent(agentId, signal);
  try {
    return await getAgent(agentId, undefined, signal);
  } catch (error) {
    if (!benchmarkAgentPreviewEnabled()) {
      throw error;
    }
    return getBenchmarkAgentPreview(agentId, signal);
  }
}

/** Post a user message to the given agent. */
export async function postAgentMessage(agentId: string, text: string) {
  return postMessageAPI(agentId, text);
}
