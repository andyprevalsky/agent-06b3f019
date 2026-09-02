/**
 * Summarize Temporal workflow history for cold/handoff gate checks.
 *
 * `activeTimers` counts TimerStarted events that have not yet been matched by
 * TimerFired or TimerCanceled (via startedEventId). A fired-only or
 * canceled-only history must not look like an armed wait_condition.
 */

export type WorkflowHistoryEventLike = {
  eventId?: string | number | bigint | null;
  timerStartedEventAttributes?: unknown;
  timerFiredEventAttributes?: { startedEventId?: string | number | bigint | null } | null;
  timerCanceledEventAttributes?: { startedEventId?: string | number | bigint | null } | null;
  activityTaskScheduledEventAttributes?: unknown;
  markerRecordedEventAttributes?: unknown;
  workflowTaskFailedEventAttributes?: unknown;
  workflowTaskScheduledEventAttributes?: unknown;
  workflowTaskStartedEventAttributes?: unknown;
  workflowTaskCompletedEventAttributes?: unknown;
};

export type WorkflowHistoryMetrics = {
  totalEvents: number;
  activities: number;
  markers: number;
  workflowTaskFailures: number;
  workflowTasks: number;
  timers: number;
  activeTimers: number;
};

function eventIdKey(id: string | number | bigint | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  return String(id);
}

export function summarizeWorkflowHistory(
  events: WorkflowHistoryEventLike[] | null | undefined
): WorkflowHistoryMetrics {
  const list = events ?? [];
  const openStarted = new Set<string>();
  let timers = 0;

  for (const event of list) {
    if (event.timerStartedEventAttributes != null) {
      timers += 1;
      const key = eventIdKey(event.eventId);
      if (key !== null) openStarted.add(key);
    }
    const fired = event.timerFiredEventAttributes;
    if (fired != null) {
      timers += 1;
      const key = eventIdKey(fired.startedEventId);
      if (key !== null) openStarted.delete(key);
    }
    const canceled = event.timerCanceledEventAttributes;
    if (canceled != null) {
      timers += 1;
      const key = eventIdKey(canceled.startedEventId);
      if (key !== null) openStarted.delete(key);
    }
  }

  return {
    totalEvents: list.length,
    activities: list.filter((event) => event.activityTaskScheduledEventAttributes != null)
      .length,
    markers: list.filter((event) => event.markerRecordedEventAttributes != null).length,
    workflowTaskFailures: list.filter((event) => event.workflowTaskFailedEventAttributes != null)
      .length,
    workflowTasks: list.filter(
      (event) =>
        event.workflowTaskScheduledEventAttributes != null ||
        event.workflowTaskStartedEventAttributes != null ||
        event.workflowTaskCompletedEventAttributes != null
    ).length,
    timers,
    activeTimers: openStarted.size,
  };
}

export function sameWorkflowHistoryMetrics(
  a: WorkflowHistoryMetrics,
  b: WorkflowHistoryMetrics
): boolean {
  return (
    a.totalEvents === b.totalEvents &&
    a.activities === b.activities &&
    a.markers === b.markers &&
    a.workflowTaskFailures === b.workflowTaskFailures &&
    a.workflowTasks === b.workflowTasks &&
    a.timers === b.timers &&
    a.activeTimers === b.activeTimers
  );
}
