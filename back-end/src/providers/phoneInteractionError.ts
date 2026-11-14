export class PhoneInteractionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Stable machine-readable reason, surfaced as an operation errorCode. */
    public readonly code?: string,
    /** Non-secret, agent-actionable detail stored with the failed operation's result. */
    public readonly detail?: Record<string, unknown>
  ) {
    super(message);
  }
}
