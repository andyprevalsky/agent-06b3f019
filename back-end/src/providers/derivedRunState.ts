import { Prisma } from '@prisma/client';

/** Per-run artifacts that must not survive a terminal → new-chat-run cutover. */
export const DERIVED_RUN_STATE_RESET = {
  responseSchema: Prisma.DbNull,
  structuredResponse: Prisma.DbNull,
  progress: 0,
  progressEstimate: Prisma.DbNull,
  progressEstimateGeneration: null,
  toolsInUse: [] as string[],
  statusMessage: null,
} as const;

/**
 * Follow-up after a finished run: clear derived artifacts and persist the
 * chat-router goal onto Agent.goal so schema / demo-cache / title-fallback
 * key off the new task. First-run escalate must not call this — 2026-07-03
 * forbids overwriting create-time Agent.goal with an LLM paraphrase.
 *
 * The previous goal is not deleted from history (original USER + Cloud Agent
 * `previousGoal` snapshot). This only replaces the live Agent.goal pointer.
 */
export function followUpRunStateUpdate(nextGoal: string, previousGoal: string) {
  const goal = nextGoal.trim();
  const persistGoal = goal.length > 0 && goal !== previousGoal;
  return {
    ...DERIVED_RUN_STATE_RESET,
    ...(persistGoal ? { goal } : {}),
  };
}

export function shouldSnapshotPreviousGoal(nextGoal: string, previousGoal: string): boolean {
  const goal = nextGoal.trim();
  return goal.length > 0 && goal !== previousGoal;
}
