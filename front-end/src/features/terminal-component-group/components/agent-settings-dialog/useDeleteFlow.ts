/**
 * Delete-agent state machine.
 *
 * [IDLE] --show--> [CONFIRM_DELETE] --1.8s--> [CONFIRM_ENABLED] --confirm--> [DELETING]
 *                        |-------- cancel -----------> [IDLE]
 *
 * Also resets to IDLE whenever `open` flips to false or the agent identity changes.
 */

import { useCallback, useEffect, useState } from 'react';
import { deleteAgent, useToast, type AgentDetail } from '../../hooks';

const CONFIRM_DELAY_MS = 1800;

interface UseDeleteFlowOptions {
  agent: AgentDetail | null;
  open: boolean;
  onDeleted: () => void;
}

export interface UseDeleteFlowResult {
  showDeleteSection: boolean;
  confirmEnabled: boolean;
  isDeleting: boolean;
  startDelete: () => void;
  cancelDelete: () => void;
  confirmDelete: () => Promise<void>;
}

export function useDeleteFlow({
  agent,
  open,
  onDeleted,
}: UseDeleteFlowOptions): UseDeleteFlowResult {
  const { toast } = useToast();
  const [showDeleteSection, setShowDeleteSection] = useState(false);
  const [confirmEnabled, setConfirmEnabled] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Reset when the agent identity changes or the dialog closes.
  useEffect(() => {
    setShowDeleteSection(false);
    setConfirmEnabled(false);
  }, [agent]);

  useEffect(() => {
    if (!open) {
      setShowDeleteSection(false);
      setConfirmEnabled(false);
    }
  }, [open]);

  // Arm the confirm button after CONFIRM_DELAY_MS once the section is shown.
  useEffect(() => {
    if (!showDeleteSection) return;
    setConfirmEnabled(false);
    const timer = setTimeout(() => setConfirmEnabled(true), CONFIRM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [showDeleteSection]);

  const startDelete = useCallback(() => setShowDeleteSection(true), []);
  const cancelDelete = useCallback(() => {
    setShowDeleteSection(false);
    setConfirmEnabled(false);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!agent || !confirmEnabled) return;
    setIsDeleting(true);
    try {
      await deleteAgent(agent.agent_id);
      toast({
        title: 'Agent deleted',
        description: 'The agent and its workflow have been terminated',
      });
      onDeleted();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete agent',
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  }, [agent, confirmEnabled, onDeleted, toast]);

  return {
    showDeleteSection,
    confirmEnabled,
    isDeleting,
    startDelete,
    cancelDelete,
    confirmDelete,
  };
}
