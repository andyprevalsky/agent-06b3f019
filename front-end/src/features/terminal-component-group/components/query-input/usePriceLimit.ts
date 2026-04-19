/**
 * Price-limit editing hook.
 *
 * Owns the editing state (is-open, input string, saving spinner) and the save
 * path that either calls `updateAgent` for a real agent or bubbles a pending
 * value through `onPendingPriceLimitChange` for a not-yet-created agent.
 */

import { useState, useCallback } from 'react';
import { updateAgent, useToast, type AgentDetail } from '../../hooks';

interface UsePriceLimitOptions {
  agentDetail?: AgentDetail | null;
  pendingPriceLimitCents: number;
  onPendingPriceLimitChange?: (cents: number) => void;
  onAgentUpdate?: () => void;
}

export interface UsePriceLimitResult {
  isEditing: boolean;
  isSaving: boolean;
  input: string;
  setInput: (value: string) => void;
  startEdit: () => void;
  save: () => Promise<void>;
  cancel: () => void;
}

export function usePriceLimit({
  agentDetail,
  pendingPriceLimitCents,
  onPendingPriceLimitChange,
  onAgentUpdate,
}: UsePriceLimitOptions): UsePriceLimitResult {
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [input, setInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const startEdit = useCallback(() => {
    if (agentDetail?.parent_agent_id) return;
    const cents = agentDetail
      ? agentDetail.price_limit_cents || 100
      : pendingPriceLimitCents;
    setInput((cents / 100).toFixed(2));
    setIsEditing(true);
  }, [agentDetail, pendingPriceLimitCents]);

  const cancel = useCallback(() => {
    setIsEditing(false);
    const cents = agentDetail
      ? agentDetail.price_limit_cents || 100
      : pendingPriceLimitCents;
    setInput((cents / 100).toFixed(2));
  }, [agentDetail, pendingPriceLimitCents]);

  const save = useCallback(async () => {
    const cents = Math.round(parseFloat(input) * 100);
    if (isNaN(cents) || cents < 1) {
      toast({
        title: 'Invalid amount',
        description: 'Please enter a valid dollar amount (minimum $0.01)',
        variant: 'destructive',
      });
      return;
    }
    if (agentDetail) {
      await savePersisted({
        agentDetail,
        newLimitCents: cents,
        toast,
        setIsSaving,
        setIsEditing,
        onAgentUpdate,
      });
    } else {
      onPendingPriceLimitChange?.(cents);
      toast({
        title: 'Price limit set',
        description: `New agents will use $${(cents / 100).toFixed(2)} limit`,
      });
      setIsEditing(false);
    }
  }, [input, agentDetail, onAgentUpdate, onPendingPriceLimitChange, toast]);

  return { isEditing, isSaving, input, setInput, startEdit, save, cancel };
}

type ToastFn = ReturnType<typeof useToast>['toast'];

interface SavePersistedArgs {
  agentDetail: AgentDetail;
  newLimitCents: number;
  toast: ToastFn;
  setIsSaving: React.Dispatch<React.SetStateAction<boolean>>;
  setIsEditing: React.Dispatch<React.SetStateAction<boolean>>;
  onAgentUpdate?: () => void;
}

async function savePersisted({
  agentDetail,
  newLimitCents,
  toast,
  setIsSaving,
  setIsEditing,
  onAgentUpdate,
}: SavePersistedArgs): Promise<void> {
  const treeCost = agentDetail.tree_cost_cents || 0;
  if (newLimitCents < treeCost) {
    toast({
      title: 'Limit too low',
      description: `New limit must be at least $${(treeCost / 100).toFixed(2)} (current cost)`,
      variant: 'destructive',
    });
    return;
  }
  setIsSaving(true);
  try {
    await updateAgent(agentDetail.agent_id, { price_limit_cents: newLimitCents });
    toast({
      title: 'Price limit updated',
      description: `New limit: $${(newLimitCents / 100).toFixed(2)}`,
    });
    setIsEditing(false);
    onAgentUpdate?.();
  } catch (error) {
    toast({
      title: 'Error',
      description: error instanceof Error ? error.message : 'Failed to update price limit',
      variant: 'destructive',
    });
  } finally {
    setIsSaving(false);
  }
}

/** Sanitize the free-form dollar input to digits + a single decimal point. */
export function sanitizePriceInput(raw: string): string {
  const filtered = raw.replace(/[^0-9.]/g, '');
  const parts = filtered.split('.');
  return parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : filtered;
}
