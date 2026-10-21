/** The JEV estimate is independent of the legacy lifecycle progress counter. */
export interface ProgressEstimate {
  progress: number;
  etaSeconds: number;
  observedAt: string;
  sequence: number;
  model: 'jev-1.13.0';
  promptVersion: string;
  taskId?: string;
}

/** Both clocks must advance; retries and reordered predictions are no-ops. */
export function isNewerProgressEstimate(
  previous: ProgressEstimate | null,
  incoming: ProgressEstimate
): boolean {
  return (
    previous === null ||
    (incoming.sequence > previous.sequence &&
      Date.parse(incoming.observedAt) >= Date.parse(previous.observedAt))
  );
}
