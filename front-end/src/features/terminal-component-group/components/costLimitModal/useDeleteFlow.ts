import { useCallback, useEffect, useState } from 'react';
import { deleteAgent, useToast } from '../../hooks';

const CONFIRM_DELAY_MS = 1800;

interface Args {
  agentId: string;
  open: boolean;
  onSuccess: () => void;
}

export function useDeleteFlow({ agentId, open, onSuccess }: Args) {
  const { toast } = useToast();
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmEnabled, setConfirmEnabled] = useState(false);

  useEffect(() => {
    if (open) {
      setShowDeleteConfirm(false);
      setConfirmEnabled(false);
    }
  }, [open]);

  useEffect(() => {
    if (!showDeleteConfirm) return;
    setConfirmEnabled(false);
    const timer = setTimeout(() => setConfirmEnabled(true), CONFIRM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [showDeleteConfirm]);

  const startConfirm = useCallback(() => setShowDeleteConfirm(true), []);
  const cancelConfirm = useCallback(() => setShowDeleteConfirm(false), []);

  const confirmDelete = useCallback(async () => {
    if (!confirmEnabled) return;
    setIsDeleting(true);
    try {
      await deleteAgent(agentId);
      toast({
        title: 'Agent deleted',
        description: 'The agent and its workflow have been terminated',
      });
      onSuccess();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete agent',
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  }, [agentId, confirmEnabled, onSuccess, toast]);

  return {
    isDeleting,
    showDeleteConfirm,
    confirmEnabled,
    startConfirm,
    cancelConfirm,
    confirmDelete,
  };
}
