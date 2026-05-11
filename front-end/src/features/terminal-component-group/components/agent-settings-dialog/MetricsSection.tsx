/**
 * Metrics block: message count, combined token counts, cost, optional inline
 * price-limit row, context-usage progress bar, and a debug agent-id row gated
 * on DEV mode or the admin user.
 */

import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { useAuth, useAppData, type AgentDetail } from '../../hooks';
import { ADMIN_USER_IDS, IS_DEV_MODE } from '../../config';
import { getModelContextWindow, formatCentsAsDollars } from './helpers';
import PriceLimitRow from './PriceLimitRow';
import type { UsePriceLimitEditResult } from './usePriceLimitEdit';

interface MetricsSectionProps {
  agent: AgentDetail;
  priceLimitEdit: UsePriceLimitEditResult;
}

export default function MetricsSection({ agent, priceLimitEdit }: MetricsSectionProps) {
  const { models } = useAppData();
  const { user: authUser } = useAuth();

  const modelsList = Array.isArray(models) ? models : [];
  const maxWindow = getModelContextWindow(agent.model, modelsList);
  const restartThreshold = Math.round(maxWindow * 0.8);
  const contextPercentage = Math.min(100, (agent.context_size / restartThreshold) * 100);

  const totalTokensIn = (agent.tokens_in || 0) + (agent.tool_tokens_in || 0);
  const totalTokensOut = (agent.tokens_out || 0) + (agent.tool_tokens_out || 0);
  const treeCostDisplay = formatCentsAsDollars(agent.tree_cost_cents || 0);

  const showDebug = IS_DEV_MODE || (authUser?.id != null && ADMIN_USER_IDS.includes(authUser.id));

  return (
    <div className="space-y-3">
      <Label>Metrics</Label>
      <div className="space-y-1">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Messages</span>
          <span className="font-mono">{agent.message_count}</span>
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Tokens In/Out</span>
          <span className="font-mono">
            {totalTokensIn.toLocaleString()} / {totalTokensOut.toLocaleString()}
          </span>
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Cost</span>
          <span className="font-mono">{treeCostDisplay}</span>
        </div>

        {!agent.parent_agent_id && <PriceLimitRow agent={agent} edit={priceLimitEdit} />}

        <div className="space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Context Usage</span>
            <span className="font-mono">{contextPercentage.toFixed(1)}%</span>
          </div>
          <Progress value={contextPercentage} className="h-2" />
          <p className="text-xs text-muted-foreground">
            {(agent.context_size || 0).toLocaleString()} / {restartThreshold.toLocaleString()}{' '}
            context used
          </p>
        </div>

        {showDebug && (
          <div className="space-y-2 pt-3 border-t border-dashed">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Agent ID</span>
              <span className="font-mono text-[10px]">{agent.agent_id}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
