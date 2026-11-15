/**
 * Public link-preview facts for an agent page (roselabs.ai/?agent-id=…).
 *
 *   iMessage/Linq fetcher ──GET /?agent-id──▶ Vercel api/og/agent (HTML tags)
 *                                         └─▶ Vercel api/og/agent-image (PNG)
 *                       both ──GET /api/agent-preview/:id──▶ this service
 *
 * The fetcher has no session, so this is unauthenticated and keyed by the
 * agent's unguessable UUID. It returns only a short title and a coarse state:
 * no goal text beyond a title fallback, cost, results, run time or ETA.
 */
import type { AgentStatus } from '@prisma/client';
import { findAgentPreviewRow } from './repo';

export type AgentPreviewState = 'started' | 'done' | 'stopped';

export interface AgentPreview {
  title: string;
  state: AgentPreviewState;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE = 80;

export function previewState(status: AgentStatus): AgentPreviewState {
  if (status === 'COMPLETED') return 'done';
  if (status === 'FAILED' || status === 'OUT_OF_CREDITS' || status === 'COST_LIMIT_REACHED')
    return 'stopped';
  return 'started';
}

/** The generated title, else the goal's first line, bounded for the card. */
export function previewTitle(title: string | null, goal: string): string {
  const titled = title?.trim() ?? '';
  const firstLine = goal.split('\n')[0]?.trim() ?? '';
  const source = titled !== '' ? titled : firstLine !== '' ? firstLine : 'Your Rose task';
  const text = source.replace(/\s+/g, ' ');
  const characters = Array.from(text);
  return characters.length <= MAX_TITLE
    ? text
    : `${characters
        .slice(0, MAX_TITLE - 1)
        .join('')
        .trimEnd()}…`;
}

export async function getAgentPreview(agentId: string): Promise<AgentPreview | null> {
  if (!UUID.test(agentId)) return null;
  const row = await findAgentPreviewRow(agentId);
  if (!row) return null;
  return { title: previewTitle(row.title, row.goal), state: previewState(row.status) };
}
