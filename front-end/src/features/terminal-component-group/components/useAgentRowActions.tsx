/**
 * STATE MACHINE: useAgentRowActions
 *
 * Owns the sidebar row mutations (rename / copy link / pin / archive / restore)
 * and the rename dialog that Rename opens.
 *
 * RENAME:
 *   [IDLE] --onRenameAgent(agent)--> [DIALOG OPEN] --submit--> PATCH --> [IDLE] + refresh
 *                                                  --cancel--> [IDLE]
 * PIN:      [IDLE] --onToggleAgentPin--> PATCH { pinned } --> refresh
 * ARCHIVE:  [IDLE] --onArchiveAgent----> DELETE (soft delete) --> refresh
 *                   (if the archived agent was selected, selection clears)
 * RESTORE:  [IDLE] --onRestoreAgent----> POST /unarchive --> refresh
 * COPYLINK: [IDLE] --onCopyAgentLink---> clipboard.writeText, no network
 *
 * Every mutation refreshes through the caller's `onRefresh` (useAgentList has no
 * query cache to invalidate) and surfaces failures as toasts.
 */

import { useCallback, useState } from 'react';

import { useToast } from '@/hooks/use-toast';

import RenameAgentDialog from './RenameAgentDialog';
import type { AgentRowHandlers } from './SidebarAgentList';
import { agentDisplayName } from './agentDisplayName';
import { archiveAgent, unarchiveAgent, updateAgent, type Agent } from '../hooks';

interface UseAgentRowActionsOptions {
  /** Reload the agent list after a mutation. */
  onRefresh: () => void | Promise<void>;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
}

export interface AgentRowActionsController {
  handlers: AgentRowHandlers;
  /** Render inside the owning component so the rename dialog mounts. */
  renameDialog: JSX.Element;
}

/** Shareable deep link to an agent — matches the `?agent-id=` route contract. */
export function agentShareUrl(agentId: string): string {
  return `${window.location.origin}${window.location.pathname}?agent-id=${agentId}`;
}

export function useAgentRowActions({
  onRefresh,
  selectedAgentId,
  onSelectAgent,
}: UseAgentRowActionsOptions): AgentRowActionsController {
  const { toast } = useToast();
  const [renameTarget, setRenameTarget] = useState<Agent | null>(null);

  const refresh = useCallback(() => {
    void onRefresh();
  }, [onRefresh]);

  const onRenameAgent = useCallback((agent: Agent) => setRenameTarget(agent), []);

  const submitRename = useCallback(
    async (agentId: string, title: string) => {
      try {
        await updateAgent(agentId, { title });
        refresh();
      } catch {
        toast({ title: 'Error', description: 'Failed to rename agent', variant: 'destructive' });
      }
    },
    [refresh, toast],
  );

  const onCopyAgentLink = useCallback(
    (agent: Agent) => {
      void navigator.clipboard
        .writeText(agentShareUrl(agent.agent_id))
        .then(() => toast({ title: 'Link copied' }))
        .catch(() =>
          toast({ title: 'Error', description: 'Failed to copy link', variant: 'destructive' }),
        );
    },
    [toast],
  );

  const onToggleAgentPin = useCallback(
    (agent: Agent) => {
      const nextPinned = agent.pinned_at === null || agent.pinned_at === undefined;
      void updateAgent(agent.agent_id, { pinned: nextPinned })
        .then(refresh)
        .catch(() =>
          toast({
            title: 'Error',
            description: `Failed to ${nextPinned ? 'pin' : 'unpin'} agent`,
            variant: 'destructive',
          }),
        );
    },
    [refresh, toast],
  );

  const onArchiveAgent = useCallback(
    (agent: Agent) => {
      void archiveAgent(agent.agent_id)
        .then(() => {
          // The archived agent is gone from the list, so a stale selection would
          // leave the main pane pointed at a row that no longer renders.
          if (selectedAgentId === agent.agent_id) onSelectAgent(null);
          toast({ title: `Archived "${agentDisplayName(agent)}"` });
          refresh();
        })
        .catch(() =>
          toast({ title: 'Error', description: 'Failed to archive agent', variant: 'destructive' }),
        );
    },
    [onSelectAgent, refresh, selectedAgentId, toast],
  );

  const onRestoreAgent = useCallback(
    (agent: Agent) => {
      void unarchiveAgent(agent.agent_id)
        .then(() => {
          toast({ title: `Restored "${agentDisplayName(agent)}"` });
          refresh();
        })
        .catch(() =>
          toast({ title: 'Error', description: 'Failed to restore agent', variant: 'destructive' }),
        );
    },
    [refresh, toast],
  );

  return {
    handlers: {
      onRenameAgent,
      onCopyAgentLink,
      onToggleAgentPin,
      onArchiveAgent,
      onRestoreAgent,
    },
    renameDialog: (
      <RenameAgentDialog
        agent={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSubmit={submitRename}
      />
    ),
  };
}
