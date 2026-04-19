import { useCallback, useState } from 'react';
import { updateAgent, useToast } from '../../hooks';
import { formatCentsAsDollars, parseDollarsToCents } from './format';

interface Args {
  agentId: string;
  currentCostCents: number;
  onSuccess: () => void;
}

export function useIncreaseLimit({ agentId, currentCostCents, onSuccess }: Args) {
  const { toast } = useToast();
  const [isUpdating, setIsUpdating] = useState(false);

  const increase = useCallback(
    async (newLimitInput: string) => {
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
        onSuccess();
      } catch (error) {
        toast({
          title: 'Error',
          description: error instanceof Error ? error.message : 'Failed to update price limit',
          variant: 'destructive',
        });
      } finally {
        setIsUpdating(false);
      }
    },
    [agentId, currentCostCents, onSuccess, toast],
  );

  return { isUpdating, increase };
}
