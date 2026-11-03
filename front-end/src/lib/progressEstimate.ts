import type { Agent, ProgressEstimate } from './api/types';

const terminal = new Set(['COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED']);
export function isTerminalStatus(status: string): boolean {
  return terminal.has(status);
}

/** Reject malformed predictions and predictions belonging to a different task. */
export function validProgressEstimate(
  value: unknown,
  rowId: string,
  taskId?: string | null,
): ProgressEstimate | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as ProgressEstimate;
  if (
    !Number.isFinite(p.progress) ||
    p.progress < 0 ||
    p.progress > 1 ||
    !Number.isFinite(p.etaSeconds) ||
    p.etaSeconds < 60 ||
    p.etaSeconds > 365 * 86400 ||
    !Number.isInteger(p.sequence) ||
    p.sequence < 0 ||
    typeof p.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(p.observedAt)) ||
    typeof p.model !== 'string' ||
    !p.model.trim() ||
    typeof p.promptVersion !== 'string' ||
    !p.promptVersion.trim() ||
    (p.taskId !== undefined && p.taskId !== (taskId ?? rowId))
  )
    return null;
  return p;
}

export function mergeProgressEstimate(
  previous: ProgressEstimate | null | undefined,
  incoming: unknown,
  rowId: string,
  status: string,
  taskId?: string | null,
): ProgressEstimate | null {
  if (isTerminalStatus(status) || incoming === null) return null;
  const old = validProgressEstimate(previous, rowId, taskId);
  const next = validProgressEstimate(incoming, rowId, taskId);
  if (!next) return old;
  if (
    old &&
    (next.sequence <= old.sequence || Date.parse(next.observedAt) < Date.parse(old.observedAt))
  )
    return old;
  return next;
}

export function hydrateProgressEstimate<
  T extends {
    agent_id: string;
    status: string;
    task_id?: string | null;
    progress_estimate?: ProgressEstimate | null;
    progressEstimate?: unknown;
    taskProgressEstimates?: Record<string, ProgressEstimate>;
    task_progress_estimates?: Record<string, ProgressEstimate>;
  },
>(row: T): T {
  return {
    ...row,
    task_progress_estimates: mergeTaskProgressEstimates(
      undefined,
      row.task_progress_estimates ?? row.taskProgressEstimates,
    ),
    progress_estimate: mergeProgressEstimate(
      undefined,
      row.progress_estimate ?? row.progressEstimate,
      row.agent_id,
      row.status,
      row.task_id,
    ),
  };
}

/** Keep a stale REST snapshot from rolling back a newer prediction or terminal state. */
export function reconcileAgent(previous: Agent | undefined, incoming: Agent): Agent {
  const next = hydrateProgressEstimate(incoming);
  if (!previous) return next;
  if (Date.parse(next.updated_at) < Date.parse(previous.updated_at)) return previous;
  if (
    isTerminalStatus(previous.status) &&
    !isTerminalStatus(next.status) &&
    Date.parse(next.updated_at) <= Date.parse(previous.updated_at)
  )
    return previous;
  if (previous.temporal_workflow_id !== next.temporal_workflow_id) return next;
  return {
    ...next,
    task_progress_estimates: mergeTaskProgressEstimates(
      previous.task_progress_estimates,
      next.task_progress_estimates,
    ),
    progress_estimate: mergeProgressEstimate(
      previous.progress_estimate,
      next.progress_estimate,
      next.agent_id,
      next.status,
      next.task_id,
    ),
  };
}

/** Ceiling to a supported model bucket; never count down from wall-clock time. */
export function formatProgressEta(seconds: number): string {
  const bins: Array<[number, string]> = [];
  for (let i = 1; i <= 59; i++) bins.push([i * 60, `${i}m`]);
  for (let i = 1; i <= 23; i++) bins.push([i * 3600, `${i}h`]);
  for (let i = 1; i <= 29; i++) bins.push([i * 86400, `${i}d`]);
  for (let i = 1; i <= 11; i++) bins.push([i * 30 * 86400, `${i}mo`]);
  return bins.find(([upper]) => seconds <= upper)?.[1] ?? '1y';
}

/** Task predictions remain keyed by their real identity, never copied onto an owner. */
export function mergeTaskProgressEstimates(
  previous: Record<string, ProgressEstimate> | undefined,
  incoming: Record<string, ProgressEstimate> | undefined,
): Record<string, ProgressEstimate> {
  let result = previous ?? {};
  for (const [taskId, estimate] of Object.entries(incoming ?? {})) {
    if (estimate?.taskId !== taskId) continue;
    const next = mergeProgressEstimate(previous?.[taskId], estimate, taskId, 'ACTIVE', taskId);
    if (next && next !== result[taskId]) {
      if (result === previous) result = { ...previous };
      result[taskId] = next;
    }
  }
  return result;
}

/** Estimate-only UPDATEs never invalidate lifecycle/list queries. */
export function isProgressEstimateUpdate(value: object): boolean {
  const update = value as Record<string, unknown>;
  return (
    (update.progressEstimate !== undefined || update.taskProgressEstimates !== undefined) &&
    Object.keys(update).every((key) =>
      [
        'agentId',
        'temporalWorkflowId',
        'updatedAt',
        'progressEstimate',
        'taskProgressEstimates',
        'taskId',
      ].includes(key),
    )
  );
}

/** Apply a generation-fenced prediction delta without changing lifecycle state. */
export function applyProgressEstimateUpdate<T extends Agent>(
  previous: T,
  update: {
    temporalWorkflowId?: string | null;
    updatedAt?: string;
    progressEstimate?: unknown;
    taskProgressEstimates?: Record<string, ProgressEstimate>;
  },
): T {
  if (
    isTerminalStatus(previous.status) ||
    (update.temporalWorkflowId !== undefined &&
      update.temporalWorkflowId !== previous.temporal_workflow_id) ||
    (update.updatedAt && Date.parse(update.updatedAt) < Date.parse(previous.updated_at))
  )
    return previous;
  const progress =
    update.progressEstimate === undefined
      ? previous.progress_estimate
      : mergeProgressEstimate(
          previous.progress_estimate,
          update.progressEstimate,
          previous.agent_id,
          previous.status,
          previous.task_id,
        );
  const tasks =
    update.taskProgressEstimates === undefined
      ? previous.task_progress_estimates
      : mergeTaskProgressEstimates(previous.task_progress_estimates, update.taskProgressEstimates);
  if (progress === previous.progress_estimate && tasks === previous.task_progress_estimates)
    return previous;
  return {
    ...previous,
    progress_estimate: progress,
    task_progress_estimates: tasks,
    updated_at: update.updatedAt ?? previous.updated_at,
  };
}
