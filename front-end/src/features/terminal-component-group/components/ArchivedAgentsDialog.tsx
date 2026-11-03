/**
 * STATE MACHINE: ArchivedAgentsDialog
 *
 * [CLOSED] --open--> [LOADING] --resolve--> [LOADED]
 *                              --reject---> [ERROR] (toast, empty list)
 * [LOADED] --Restore a row--> parent mutates --> [LOADING] (reload)
 * [LOADED] --select a row---> parent selects the agent, dialog closes
 * [ANY]    --close---------> [CLOSED] (list discarded; refetched on next open)
 *
 * Archived agents are soft-deleted rows (`deletedAt` non-null). The list is
 * bounded server-side, so this never grows without limit for a heavy account.
 *
 * LAYOUT: DialogContent is a CSS grid, and a grid item's default
 * `min-width: auto` is its min-content width. A long untruncated title (one
 * nowrap line) therefore widened the track past the dialog, and the hovered
 * row painted off the panel. `min-w-0` on the list wrapper pins it to the
 * dialog's content box so rows ellipsize at the real edge; the full goal stays
 * in each title's native tooltip. The list scrolls vertically inside its
 * max-height, below the header; a row cut at the top edge is scroll position.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';

import SidebarAgentList, { type AgentRowHandlers } from './SidebarAgentList';
import { getArchivedAgents, type Agent } from '../hooks';

interface ArchivedAgentsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectAgent: (agentId: string | null) => void;
  /** Row handlers from useAgentRowActions, minus archive (rows are already archived). */
  handlers: AgentRowHandlers;
  /** Bumped by the parent after a restore so the list refetches. */
  refreshToken: number;
}

export default function ArchivedAgentsDialog({
  open,
  onOpenChange,
  onSelectAgent,
  handlers,
  refreshToken,
}: ArchivedAgentsDialogProps) {
  const { toast } = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsLoading(true);
    getArchivedAgents()
      .then((fetched) => {
        if (!cancelled) setAgents(fetched);
      })
      .catch(() => {
        if (cancelled) return;
        setAgents([]);
        toast({
          title: 'Error',
          description: 'Failed to load archived agents',
          variant: 'destructive',
        });
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, refreshToken, toast]);

  const handleSelect = useCallback(
    (agentId: string | null) => {
      onSelectAgent(agentId);
      onOpenChange(false);
    },
    [onOpenChange, onSelectAgent],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Archived</DialogTitle>
          <DialogDescription>
            Restoring brings an agent back to the sidebar. It does not resume the run.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 max-h-[60vh] flex-col">
          <SidebarAgentList
            agents={agents}
            isLoadingAgents={isLoading}
            selectedAgentId={null}
            onSelectAgent={handleSelect}
            isCollapsed={false}
            isArchived
            emptyLabel="Nothing archived"
            {...handlers}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
