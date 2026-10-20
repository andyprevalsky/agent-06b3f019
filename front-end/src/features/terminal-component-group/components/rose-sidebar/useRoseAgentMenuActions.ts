/**
 * Builds the right-click menu actions for one Rose left-bar agent row
 * (UI ledger row 37).
 *
 *   wired to existing handlers: Archive, Pin/Unpin, Rename, Copy › Copy link
 *   Copy › Copy agent ID: clipboard write
 *   New agent in this branch, Mark unread, Mute notifications, Share, Delete,
 *   Schedule a prompt…: call the optional prop when the parent provides it,
 *   otherwise show a clear "not available yet" toast.
 */

import { useCallback } from 'react';

import { useToast } from '@/hooks/use-toast';
import type { Project } from '@/lib/api/projects';
import type { CodeAgentListItem } from '@/lib/api/tree';

import type { AgentRowHandlers } from '../SidebarAgentList';
import type { Agent } from '../../hooks';
import type { RoseAgentMenuActions } from './RoseAgentRowMenu';

/** Optional agent/project actions the Rose left bar exposes before their backends land. */
export interface RoseSidebarActions {
  onNewAgentInBranch?: (agent: Agent) => void;
  onMarkAgentUnread?: (agent: Agent) => void;
  onMuteAgent?: (agent: Agent) => void;
  onShareAgent?: (agent: Agent) => void;
  onDeleteAgent?: (agent: Agent) => void;
  onScheduleAgentPrompt?: (agent: Agent) => void;
  onCreateAgentInProject?: (project: Project) => void;
  /**
   * Open a code agent's conversation/transcript. Default: select the Rose agent
   * that owns the session; its chat holds the code agent's chip and transcript.
   */
  onOpenCodeAgent?: (codeAgent: CodeAgentListItem) => void;
  /**
   * Apps section "+ New app": start a new Super Agent with the composer
   * prefilled ("Make me an app"), never auto-sent. Default: New Super Agent.
   */
  onNewApp?: () => void;
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
  actions: RoseSidebarActions,
): (agent: Agent) => RoseAgentMenuActions {
  const { toast } = useToast();
  const notYet = useNotYet();
  const optional = useCallback(
    (fn: ((agent: Agent) => void) | undefined, feature: string, agent: Agent) => () => {
      if (fn !== undefined) fn(agent);
      else notYet(feature);
    },
    [notYet],
  );
  return useCallback(
    (agent: Agent) => ({
      onNewAgentInBranch: optional(actions.onNewAgentInBranch, 'New agent in this branch', agent),
      onArchive: () => handlers.onArchiveAgent(agent),
      onMarkUnread: optional(actions.onMarkAgentUnread, 'Mark unread', agent),
      onMute: optional(actions.onMuteAgent, 'Mute notifications', agent),
      onTogglePin: () => handlers.onToggleAgentPin(agent),
      onRename: () => handlers.onRenameAgent(agent),
      onShare: optional(actions.onShareAgent, 'Share agent', agent),
      onDelete: optional(actions.onDeleteAgent, 'Delete agent', agent),
      onSchedulePrompt: optional(actions.onScheduleAgentPrompt, 'Schedule a prompt', agent),
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
    [actions, handlers, optional, toast],
  );
}
