/**
 * Price-limit row: shows the current limit, and expands inline into an input
 * + save button when the user clicks the amount.
 *
 * Only rendered for root agents (parent_agent_id is null).
 */

import { DollarSign, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DEFAULT_AGENT_PRICE_LIMIT_CENTS } from '../../config';
import type { AgentDetail } from '../../hooks';
import type { UsePriceLimitEditResult } from './usePriceLimitEdit';

interface PriceLimitRowProps {
  agent: AgentDetail;
  edit: UsePriceLimitEditResult;
}

export default function PriceLimitRow({ agent, edit }: PriceLimitRowProps) {
  const priceLimitDollars = (
    (agent.price_limit_cents || DEFAULT_AGENT_PRICE_LIMIT_CENTS) / 100
  ).toFixed(2);

  return (
    <div className="space-y-1 pt-2 border-t border-dashed">
      <div className="flex justify-between items-center text-sm">
        <span className="text-muted-foreground">Price Limit</span>
        {!edit.isEditing ? (
          <button onClick={edit.startEdit} className="font-mono hover:underline text-primary">
            ${priceLimitDollars}
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <DollarSign className="h-3 w-3 text-muted-foreground" />
            <Input
              value={edit.input}
              onChange={(e) => edit.setInput(e.target.value)}
              className="w-20 h-6 text-xs font-mono px-1"
              placeholder="1.00"
              disabled={edit.isSaving}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void edit.save();
                if (e.key === 'Escape') edit.cancelEdit();
              }}
              autoFocus
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => void edit.save()}
              disabled={edit.isSaving}
            >
              {edit.isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
            </Button>
          </div>
        )}
      </div>
      {agent.tree_cost_cents !== undefined && agent.tree_cost_cents > 0 && (
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Tree Cost</span>
          <span className="font-mono text-muted-foreground">
            ${(agent.tree_cost_cents / 100).toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
}
