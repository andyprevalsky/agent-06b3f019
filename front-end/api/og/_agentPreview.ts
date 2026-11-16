// Public link-preview facts for /a/<agent-id> (see back-end src/domains/agent-preview).
export interface AgentPreview {
  title: string;
  state: 'started' | 'done' | 'stopped';
}

const BACKEND = (process.env.ROSE_PREVIEW_BACKEND_URL || 'https://api.roselabs.ai').replace(
  /\/$/,
  '',
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAgentId(value: string | null): value is string {
  return value !== null && UUID.test(value);
}

/** Bounded fetch: a slow backend must never delay the agent page itself. */
export async function fetchAgentPreview(agentId: string): Promise<AgentPreview | null> {
  try {
    const res = await fetch(`${BACKEND}/api/agent-preview/${agentId}`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<AgentPreview>;
    if (
      typeof data.title !== 'string' ||
      !['started', 'done', 'stopped'].includes(String(data.state))
    )
      return null;
    return { title: data.title, state: data.state as AgentPreview['state'] };
  } catch {
    return null;
  }
}

/** The line above the title, shared by the image and og:description. No run time or ETA. */
export function statusLine(preview: AgentPreview): string {
  if (preview.state === 'started') return 'Started · tap to follow along';
  return preview.state === 'done' ? 'Done' : 'Stopped';
}
