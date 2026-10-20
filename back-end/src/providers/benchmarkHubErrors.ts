/** Retryable Benchmark Hub storage/index state, distinct from a confirmed miss. */
export class BenchmarkHubUnavailableError extends Error {
  readonly statusCode = 503;
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds = 5) {
    super(message);
    this.name = 'BenchmarkHubUnavailableError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A run bundle the Hub contract rejects; replaying the same bytes cannot succeed. */
export class BenchmarkHubInvalidRecordError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkHubInvalidRecordError';
  }
}

/** An upload that conflicts with the stored group/run state; replaying it cannot succeed. */
export class BenchmarkHubConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkHubConflictError';
  }
}
