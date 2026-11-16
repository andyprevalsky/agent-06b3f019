import type { AgentStatus } from '@prisma/client';

export type { AgentStatus };

export type AgentPreviewState = 'started' | 'done' | 'stopped';

/** Everything a public link preview may show for an agent. */
export interface AgentPreview {
  title: string;
  state: AgentPreviewState;
}
