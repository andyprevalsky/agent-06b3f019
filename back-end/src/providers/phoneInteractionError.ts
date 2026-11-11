export class PhoneInteractionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Stable machine-readable reason, surfaced as an operation errorCode. */
    public readonly code?: string
  ) {
    super(message);
  }
}
