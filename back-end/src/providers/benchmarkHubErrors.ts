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
