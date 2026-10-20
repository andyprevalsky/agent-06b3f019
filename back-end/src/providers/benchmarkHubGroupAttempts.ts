/** Physical retry ownership and logical-member projection under the Hub index lock. */
import type { HubRunAttempt, HubRunSummary } from './benchmarkHubTypes';
import { BenchmarkHubConflictError } from './benchmarkHubErrors';

export function groupAttempt(run: HubRunSummary): number {
  return run.group_attempt ?? 1;
}

export function validateGroupAttempt(
  summary: HubRunSummary,
  index: HubRunSummary[],
  existing: HubRunSummary | undefined
): void {
  const peers = index.filter(
    (run) =>
      run.run_id !== summary.run_id &&
      run.group_run_id === summary.group_run_id &&
      run.group_member_id === summary.group_member_id
  );
  const attempt = groupAttempt(summary);
  if (
    peers.some((run) => groupAttempt(run) === attempt) ||
    (attempt === 1 && peers.length > 0 && !existing)
  ) {
    throw new BenchmarkHubConflictError(
      'Benchmark Hub group member already belongs to another run'
    );
  }
  if (existing || attempt === 1) return;
  const previous = peers.find((run) => groupAttempt(run) === attempt - 1);
  const task = previous?.tasks[0];
  if (
    !previous ||
    peers.length !== attempt - 1 ||
    [...peers]
      .sort((a, b) => groupAttempt(a) - groupAttempt(b))
      .some((run, index) => groupAttempt(run) !== index + 1) ||
    peers.some((run) => groupAttempt(run) >= attempt) ||
    previous.live ||
    previous.tasks.length !== 1 ||
    summary.tasks.length !== 1 ||
    task?.passed !== null ||
    !['INFRA_ERROR', 'error'].includes(task.status) ||
    task.lifecycle_stage !== 'released' ||
    task.name !== summary.tasks[0]?.name ||
    previous.group_run_number !== summary.group_run_number ||
    previous.group_timestamp !== summary.group_timestamp ||
    previous.group_total !== summary.group_total
  ) {
    throw new BenchmarkHubConflictError(
      'Benchmark Hub retry requires a contiguous released infrastructure-error attempt with unchanged membership'
    );
  }
}

export function groupMembers(children: HubRunSummary[]): Map<string, HubRunSummary[]> {
  const members = new Map<string, HubRunSummary[]>();
  for (const child of children) {
    const attempts = members.get(child.group_member_id!) ?? [];
    attempts.push(child);
    members.set(child.group_member_id!, attempts);
  }
  for (const attempts of members.values())
    attempts.sort((a, b) => groupAttempt(a) - groupAttempt(b));
  return members;
}

export function groupAttemptHistory(attempts: HubRunSummary[], slot: number): HubRunAttempt[] {
  return attempts.flatMap((run) => {
    const task = run.tasks[slot];
    return task
      ? [
          {
            group_attempt: groupAttempt(run),
            child_run_id: run.run_id,
            passed: task.passed,
            status: task.status,
            lifecycle_stage: task.lifecycle_stage,
            agent_id: task.agent_id,
            failure_reason: task.failure_reason,
            duration_seconds: task.duration_seconds,
            cost_cents: task.cost_cents,
            tokens_in: task.tokens_in,
            tokens_out: task.tokens_out,
            tree_agent_count: task.tree_agent_count,
          },
        ]
      : [];
  });
}
