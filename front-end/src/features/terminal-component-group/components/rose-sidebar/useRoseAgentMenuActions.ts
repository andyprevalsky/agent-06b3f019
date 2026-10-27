/**
 * Builds the right-click menu actions for one Rose left-bar agent row
 * (UI ledger row 37).
 *
 *   wired to existing handlers: Archive, Pin/Unpin, Rename, Copy › Copy link
 *   Copy › Copy agent ID: clipboard write
 */

import { useCallback } from 'react';

import { useToast } from '@/hooks/use-toast';
import type { Project } from '@/lib/api/projects';
import type { CodeAgentListItem } from '@/lib/api/tree';

import type { AgentRowHandlers } from '../SidebarAgentList';
import type { Agent } from '../../hooks';
import type { RoseAgentMenuActions } from './RoseAgentRowMenu';

/** Optional project/code-agent actions the Rose left bar exposes. */
export interface RoseSidebarActions {
  onCreateAgentInProject?: (project: Project) => void;
  /**
   * Open a code agent's conversation/transcript. Default: select the Rose agent
   * that owns the session; its chat holds the code agent's chip and transcript.
   */
  onOpenCodeAgent?: (codeAgent: CodeAgentListItem) => void;
}

export function useNotYet() {
  const { toast } = useToast();
  return useCallback(
    (feature: string) => toast({ title: `${feature} is not available yet` }),
    [toast],
  );
}

export function useRoseAgentMenuActions(
  handlers: AgentRowHandlers,
): (agent: Agent) => RoseAgentMenuActions {
  const { toast } = useToast();
  return useCallback(
    (agent: Agent) => ({
      onArchive: () => handlers.onArchiveAgent(agent),
      onTogglePin: () => handlers.onToggleAgentPin(agent),
      onRename: () => handlers.onRenameAgent(agent),
      onCopyLink: () => handlers.onCopyAgentLink(agent),
      onCopyId: () => {
        void navigator.clipboard
          .writeText(agent.agent_id)
          .then(() => toast({ title: 'Agent ID copied' }))
          .catch(() =>
            toast({
              title: 'Error',
              description: 'Failed to copy agent ID',
              variant: 'destructive',
            }),
          );
      },
    }),
    [handlers, toast],
  );
}
