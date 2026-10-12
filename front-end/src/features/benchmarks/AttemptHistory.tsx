import type { HubRunAttempt } from '@/lib/api/benchmarksHub';
import { Button } from '@/components/ui/button';

export function AttemptHistory({
  attempts,
  onOpenAgent,
}: {
  attempts: HubRunAttempt[];
  onOpenAgent: (runId: string, agentId: string) => void;
}) {
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer">{attempts.length} attempts</summary>
      <ol className="mt-1 space-y-1">
        {attempts.map((attempt) => (
          <li key={attempt.child_run_id} className="rounded border border-border p-1.5">
            <span>Attempt {attempt.group_attempt}:</span> · <span>{attempt.status}</span>
            {attempt.lifecycle_stage === 'released' && <span> · Resources released</span>}
            {attempt.cost_cents !== null && (
              <span> · ${(attempt.cost_cents / 100).toFixed(2)}</span>
            )}
            {attempt.failure_reason && <div>{attempt.failure_reason}</div>}
            <Button
              variant="outline"
              size="sm"
              className="mt-1 h-6 px-2 text-xs"
              disabled={!attempt.agent_id?.trim()}
              onClick={() => {
                const agentId = attempt.agent_id?.trim();
                if (agentId) onOpenAgent(attempt.child_run_id, agentId);
              }}
            >
              Open attempt {attempt.group_attempt} agent
            </Button>
          </li>
        ))}
      </ol>
    </details>
  );
}
