export const CLOUD_AGENT_TOOL_NAME = 'cloud_agent';
export const CREATING_CLOUD_AGENT_TITLE = 'Creating Cloud Agent';
export const CLOUD_AGENT_CREATED_TITLE = 'Cloud Agent Created';

export function isCloudAgentLifecycleTool(metadata?: Record<string, unknown>): boolean {
  return metadata?.toolName === CLOUD_AGENT_TOOL_NAME;
}
