/**
 * Price-limit inline editor for AgentSettingsDialog.
 *
 * Owns: input string, editing flag, saving spinner.
 * Guards: rejects NaN/<1c and any value below the already-accrued tree cost.
 * On save: PATCH /api/agents/:id with `price_limit_cents` then fires onUpdated.
 */

import { useCallback, useEffect, useState } from 'react';
import { updateAgent, useToast, type AgentDetail } from '../../hooks';

interface UsePriceLimitEditOptions {
  agent: AgentDetail | null;
  onUpdated: () => void;
}

export interface UsePriceLimitEditResult {
  input: string;
  setInput: (v: string) => void;
  isEditing: boolean;
  startEdit: () => void;
  cancelEdit: () => void;
  isSaving: boolean;
  save: () => Promise<void>;
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function usePriceLimitEdit({
  agent,
  onUpdated,
}: UsePriceLimitEditOptions): UsePriceLimitEditResult {
  const { toast } = useToast();
  const [input, setInput] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Sync input with agent identity / latest price limit.
  useEffect(() => {
    setIsEditing(false);
    if (agent?.price_limit_cents !== undefined) {
      setInput(formatCents(agent.price_limit_cents));
    }
  }, [agent]);

  const startEdit = useCallback(() => setIsEditing(true), []);
  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    if (agent?.price_limit_cents !== undefined) {
      setInput(formatCents(agent.price_limit_cents));
    }
  }, [agent]);

  const save = useCallback(async () => {
    if (!agent) return;
    const newLimitCents = Math.round(parseFloat(input) * 100);
    if (isNaN(newLimitCents) || newLimitCents < 1) {
      toast({
        title: 'Invalid amount',
        description: 'Please enter a valid dollar amount (minimum $0.01)',
        variant: 'destructive',
      });
      return;
    }
    const treeCost = agent.tree_cost_cents || 0;
    if (newLimitCents < treeCost) {
      toast({
        title: 'Limit too low',
        description: `New limit must be at least $${formatCents(treeCost)} (current cost)`,
        variant: 'destructive',
      });
      return;
    }

    setIsSaving(true);
    try {
      await updateAgent(agent.agent_id, { price_limit_cents: newLimitCents });
      toast({
        title: 'Price limit updated',
        description: `New limit: $${formatCents(newLimitCents)}`,
      });
      setIsEditing(false);
      onUpdated();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update price limit',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  }, [agent, input, onUpdated, toast]);

  return { input, setInput, isEditing, startEdit, cancelEdit, isSaving, save };
}
