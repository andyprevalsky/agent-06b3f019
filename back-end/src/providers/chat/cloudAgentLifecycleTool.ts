export const CLOUD_AGENT_TOOL_NAME = 'cloud_agent';
export const CREATING_CLOUD_AGENT_TITLE = 'Creating Cloud Agent';
export const PREPARING_CLOUD_AGENT_TITLE = 'Preparing Cloud Agent';
export const STARTING_REASONING_TITLE = 'Starting Reasoning';
export const CLOUD_AGENT_READY_TITLE = 'Cloud Agent Ready';

export function isCloudAgentLifecycleTool(metadata?: Record<string, unknown>): boolean {
  return metadata?.toolName === CLOUD_AGENT_TOOL_NAME;
}
