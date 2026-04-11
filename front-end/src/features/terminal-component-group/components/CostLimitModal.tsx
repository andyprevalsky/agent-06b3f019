/**
 * STATE MACHINE: CostLimitModal
 *
 * [CLOSED] <-- Dialog closed
 *     |
 *     v (status=COST_LIMIT_REACHED)
 * [OPEN]
 *     |
 *     +--> [IDLE] <-- showDeleteConfirm: false
 *     |       |
 *     |       +--> (increase click) --> [UPDATING] <-- isUpdating: true
 *     |       |       |
 *     |       |       +--> (success) --> [CLOSED] + resume
 *     |       |       +--> (error) --> [IDLE]
 *     |       |
 *     |       +--> (delete click)
 *     |               |
 *     |               v
 *     |       [DELETE_CONFIRM] <-- showDeleteConfirm: true, confirmEnabled: false
 *     |               |
 *     |               | (1.8s delay)
 *     |               v
 *     |       [CONFIRM_ENABLED] <-- confirmEnabled: true
 *     |               |
 *     |               +--> (confirm) --> [DELETING] <-- isDeleting: true --> [CLOSED]
 *     |               +--> (cancel) --> [IDLE]
 *     |
 *     +--> (close) --> [CLOSED]
 */

import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Trash2, DollarSign } from 'lucide-react';
import { updateAgent, deleteAgent } from '../hooks';
import { useToast } from '../hooks';

interface CostLimitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  currentLimitCents: number; // from agent.price_limit_cents
  currentCostCents: number; // from agent.tree_cost_cents
  onIncrease?: () => void; // Called after successful increase
  onDelete?: () => void; // Called after successful delete
}

function formatCentsAsDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function parseDollarsToCents(value: string): number | null {
  // Remove $ sign and trim
  const cleaned = value.replace(/\$/g, '').trim();
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export default function CostLimitModal({
  open,
  onOpenChange,
  agentId,
  currentLimitCents,
  currentCostCents,
  onIncrease,
  onDelete,
}: CostLimitModalProps) {
  const { toast } = useToast();

  // State
  const [newLimitInput, setNewLimitInput] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmEnabled, setConfirmEnabled] = useState(false);

  // Initialize input to current limit + 50 cents when modal opens
  useEffect(() => {
    if (open) {
      const defaultNewLimit = currentLimitCents + 50;
      setNewLimitInput(formatCentsAsDollars(defaultNewLimit));
      setShowDeleteConfirm(false);
      setConfirmEnabled(false);
    }
  }, [open, currentLimitCents]);

  // 1.8s delay for delete confirmation
  useEffect(() => {
    if (showDeleteConfirm) {
      setConfirmEnabled(false);
      const timer = setTimeout(() => {
        setConfirmEnabled(true);
      }, 1800);
      return () => clearTimeout(timer);
    }
  }, [showDeleteConfirm]);

  const handleIncrease = async () => {
    const newLimitCents = parseDollarsToCents(newLimitInput);

    if (newLimitCents === null) {
      toast({
        title: 'Invalid amount',
        description: 'Please enter a valid dollar amount',
        variant: 'destructive',
      });
      return;
    }

    if (newLimitCents < currentCostCents) {
      toast({
        title: 'Limit too low',
        description: `New limit must be at least ${formatCentsAsDollars(currentCostCents)} (current cost)`,
        variant: 'destructive',
      });
      return;
    }

    setIsUpdating(true);
    try {
      await updateAgent(agentId, { price_limit_cents: newLimitCents });
      toast({
        title: 'Price limit increased',
        description: `New limit: ${formatCentsAsDollars(newLimitCents)}`,
      });
      onOpenChange(false);
      onIncrease?.();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update price limit',
        variant: 'destructive',
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmEnabled) return;

    setIsDeleting(true);
    try {
      await deleteAgent(agentId);
      toast({
        title: 'Agent deleted',
        description: 'The agent and its workflow have been terminated',
      });
      onOpenChange(false);
      onDelete?.();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete agent',
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent
        className="sm:max-w-md p-0 border border-gray-300 dark:border-gray-700 shadow-lg [&>button]:hidden overflow-hidden"
        style={{
          backgroundColor: 'transparent',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <div className="p-6" style={{ backgroundColor: 'transparent' }}>
          <DialogHeader>
            <DialogTitle className="text-foreground">
              This Task Has Crossed the Price Limit Set
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-6 py-4">
            {/* Current Cost Display */}
            <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border">
              <div>
                <p className="text-sm text-muted-foreground">Current Cost Consumed</p>
                <p className="text-2xl font-bold font-mono">
                  {formatCentsAsDollars(currentCostCents)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-muted-foreground">Price Limit</p>
                <p className="text-lg font-mono text-muted-foreground">
                  {formatCentsAsDollars(currentLimitCents)}
                </p>
              </div>
            </div>

            {/* New Limit Input */}
            <div className="space-y-2">
              <Label htmlFor="new-limit">New Price Limit</Label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="new-limit"
                  value={newLimitInput}
                  onChange={(e) => setNewLimitInput(e.target.value)}
                  placeholder="0.75"
                  className="pl-8 font-mono"
                  disabled={isUpdating}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Must be at least {formatCentsAsDollars(currentCostCents)} (current cost)
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-3">
              {/* Delete Section (Left) */}
              {!showDeleteConfirm ? (
                <Button
                  onClick={() => setShowDeleteConfirm(true)}
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-500/30"
                  disabled={isUpdating}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Button
                    onClick={() => setShowDeleteConfirm(false)}
                    variant="outline"
                    size="sm"
                    disabled={isDeleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleDelete}
                    disabled={isDeleting || !confirmEnabled}
                    size="sm"
                    className="bg-red-600 hover:bg-red-700 text-white"
                  >
                    {isDeleting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : confirmEnabled ? (
                      'Confirm'
                    ) : (
                      'Wait...'
                    )}
                  </Button>
                </div>
              )}

              {/* Spacer */}
              <div className="flex-1" />

              {/* Increase Limit Button (Right) */}
              <Button
                onClick={handleIncrease}
                disabled={isUpdating || showDeleteConfirm}
                className="bg-black hover:bg-black/90 text-white dark:bg-white dark:hover:bg-white/90 dark:text-black"
              >
                {isUpdating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Updating...
                  </>
                ) : (
                  'Increase Limit'
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
