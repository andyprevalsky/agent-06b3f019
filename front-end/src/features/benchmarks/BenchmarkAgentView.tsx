/**
 * STATE MACHINE: BenchmarkAgentView
 *
 *   mount(runId, agentId) ──► loading ──GET ok──► ready(agent, messages, tree)
 *        │                        │
 *        │                        └─GET fail──► error (retry → loading)
 *   ready + click tree node ──► loading(other agent in the SAME run) ──► ready
 *   ready + Back ──► onBack() (parent restores the hub panes)
 *
 * Renders a benchmark agent transcript IN-APP from the uploaded run bundle
 * (the per-bench cloud DB is gone by view time, so this is bundle-served and
 * RLS-free via the team-gated hub endpoint). The fan-out tree from the
 * full-tree copy-down is listed left; clicking a sub-agent swaps the
 * transcript without leaving the app.
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Bot, Loader2, User, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MarkdownText } from '@/features/terminal-component-group/components/MarkdownText';
import type { HubAgentView } from '@/lib/api/benchmarksHub';
import { fetchHubRunAgent } from '@/lib/api/benchmarksHub';

interface BenchmarkAgentViewProps {
  runId: string;
  agentId: string;
  onBack: () => void;
}

function roleIcon(role: string) {
  if (role === 'USER') return <User className="h-3.5 w-3.5" />;
  if (role === 'TOOL') return <Wrench className="h-3.5 w-3.5" />;
  return <Bot className="h-3.5 w-3.5" />;
}

function toolTitle(metadata: Record<string, unknown>): string | null {
  const toolName = typeof metadata.toolName === 'string' ? metadata.toolName : null;
  const title = typeof metadata.title === 'string' ? metadata.title : null;
  if (toolName === null && title === null) return null;
  return [toolName, title].filter(Boolean).join(' — ');
}

export function BenchmarkAgentView({ runId, agentId, onBack }: BenchmarkAgentViewProps) {
  const [currentAgentId, setCurrentAgentId] = useState(agentId);
  const [view, setView] = useState<HubAgentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (targetAgentId: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchHubRunAgent(runId, targetAgentId);
        setView(data);
        setCurrentAgentId(targetAgentId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [runId],
  );

  useEffect(() => {
    void load(agentId);
  }, [agentId, load]);

  const tree = view?.tree ?? [];
  const showTree = tree.length > 1;

  return (
    <div className="flex flex-col h-full min-h-0 pt-20 pb-4" data-testid="benchmark-agent-view">
      <div className="flex items-center gap-3 pb-3">
        <Button variant="outline" size="sm" onClick={onBack} data-testid="agent-back">
          <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Benchmarks
        </Button>
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">
            {String(view?.agent.goal ?? currentAgentId)}
          </div>
          <div className="text-[11px] text-muted-foreground font-mono truncate">
            {runId} · {currentAgentId}
          </div>
        </div>
        {view !== null && (
          <Badge variant="outline" className="ml-auto shrink-0">
            {String(view.agent.status ?? '')}
          </Badge>
        )}
      </div>

      <div className="flex-1 min-h-0 flex gap-3">
        {showTree && (
          <div
            className="w-64 shrink-0 overflow-y-auto rounded-md border border-border p-2 space-y-0.5"
            data-testid="agent-tree"
          >
            <div className="text-[11px] font-semibold text-muted-foreground pb-1">
              Agent tree ({tree.length})
            </div>
            {tree.map((node) => (
              <button
                key={node.agent_id}
                className={cn(
                  'w-full text-left rounded px-2 py-1.5 text-xs hover:bg-muted',
                  node.agent_id === currentAgentId && 'bg-muted font-medium',
                  node.parent_agent_id !== null && 'pl-5',
                )}
                onClick={() => void load(node.agent_id)}
                data-testid={`tree-node-${node.agent_id}`}
              >
                <div className="truncate">{node.goal || node.agent_id}</div>
                <div className="text-[10px] text-muted-foreground">
                  {node.status.toLowerCase()} · {node.message_count} msg
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1" data-testid="agent-messages">
          {loading && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading transcript…
            </div>
          )}
          {error !== null && !loading && (
            <div className="py-8 text-sm text-red-600">
              {error}{' '}
              <button className="underline" onClick={() => void load(currentAgentId)}>
                retry
              </button>
            </div>
          )}
          {!loading &&
            error === null &&
            view !== null &&
            view.messages.map((message) => {
              const tool = toolTitle(message.metadata);
              return (
                <div
                  key={message.message_id}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-sm',
                    message.role === 'USER'
                      ? 'bg-muted/60 border-border'
                      : message.role === 'TOOL'
                        ? 'bg-background border-dashed border-border/80'
                        : 'bg-background border-border',
                  )}
                >
                  <div className="flex items-center gap-1.5 pb-1 text-[11px] text-muted-foreground">
                    {roleIcon(message.role)}
                    <span>{message.role.toLowerCase()}</span>
                    {tool !== null && <span className="truncate">· {tool}</span>}
                    {message.timestamp !== '' && (
                      <span className="ml-auto shrink-0">
                        {new Date(message.timestamp).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  {message.text !== '' ? (
                    message.role === 'ASSISTANT' ? (
                      <MarkdownText text={message.text} />
                    ) : (
                      <div className="whitespace-pre-wrap break-words">{message.text}</div>
                    )
                  ) : (
                    <div className="text-muted-foreground text-xs italic">(no text)</div>
                  )}
                </div>
              );
            })}
          {!loading && error === null && view !== null && view.messages.length === 0 && (
            <div className="py-8 text-sm text-muted-foreground">
              No transcript captured for this agent.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
