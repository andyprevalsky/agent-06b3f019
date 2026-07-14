export const OPEN_AGENT_EVENT = 'rose:open-agent';

export function openAgentInCurrentClient(agentId: string): void {
  const url = new URL(window.location.href);
  const previousAgentId = url.searchParams.get('agent-id');
  url.searchParams.set('agent-id', agentId);
  if (previousAgentId !== agentId) url.searchParams.delete('browser-id');
  url.hash = '#/';
  window.history.replaceState({}, '', url.toString());
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.dispatchEvent(new CustomEvent(OPEN_AGENT_EVENT, { detail: { agentId } }));
}
