/**
 * Metrics block: message count, combined token counts, cost, optional inline
 * price-limit row, context-usage progress bar, and a debug agent-id row gated
 * on DEV mode or the admin user.
 *
 * STATE MACHINE (agent ID copy):
 * [IDLE] --copy succeeds--> [COPIED] --different agent--> [IDLE]
 * [IDLE] --copy fails----> [ERROR]  --next attempt----> [COPIED or ERROR]
 */

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { copyToClipboard } from '@/lib/clipboard';
import { useAuth, useAppData, type AgentDetail } from '../../hooks';
import { ADMIN_USER_IDS, IS_DEV_MODE } from '../../config';
import { getModelContextWindow, formatCentsAsDollars } from './helpers';
import PriceLimitRow from './PriceLimitRow';
import type { UsePriceLimitEditResult } from './usePriceLimitEdit';

interface MetricsSectionProps {
  agent: AgentDetail;
  priceLimitEdit: UsePriceLimitEditResult;
  /** Real window of a code agent's model; absent for a Rose agent (restart threshold applies). */
  contextWindow?: number;
}

/** A Rose agent is measured against its restart threshold; a code agent against its real window. */
function contextUsage(agent: AgentDetail, models: unknown, contextWindow: number | undefined) {
  const modelsList = Array.isArray(models) ? models : [];
  const restartThreshold =
    contextWindow ?? Math.round(getModelContextWindow(agent.model, modelsList) * 0.8);
  return {
    restartThreshold,
    contextPercentage: Math.min(100, (agent.context_size / restartThreshold) * 100),
  };
}

export default function MetricsSection({
  agent,
  priceLimitEdit,
  contextWindow,
}: MetricsSectionProps) {
  const [copiedAgentId, setCopiedAgentId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const { models } = useAppData();
  const { user: authUser } = useAuth();

  const { restartThreshold, contextPercentage } = contextUsage(agent, models, contextWindow);

  const totalTokensIn = (agent.tokens_in || 0) + (agent.tool_tokens_in || 0);
  const totalTokensOut = (agent.tokens_out || 0) + (agent.tool_tokens_out || 0);
  const treeCostDisplay = formatCentsAsDollars(agent.tree_cost_cents || 0);

  const showDebug = IS_DEV_MODE || (authUser?.id != null && ADMIN_USER_IDS.includes(authUser.id));
  const isCopied = copiedAgentId === agent.agent_id;

  async function copyAgentId() {
    try {
      await copyToClipboard(`agent-id: <${agent.agent_id}>`);
      setCopiedAgentId(agent.agent_id);
      setCopyError(false);
    } catch {
      setCopiedAgentId(null);
      setCopyError(true);
    }
  }

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
            <div className="flex justify-between items-center gap-2 text-xs">
              <span className="text-muted-foreground">Agent ID</span>
              <div className="flex min-w-0 items-center gap-1">
                <span className="font-mono text-[10px] break-all">{agent.agent_id}</span>
                <button
                  type="button"
                  onClick={() => void copyAgentId()}
                  aria-label="Copy agent ID"
                  title={isCopied ? 'Copied agent ID' : 'Copy agent ID'}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {isCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
            {copyError && <p className="text-xs text-destructive">Could not copy agent ID.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
