export class AgentCardProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
    readonly code?: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'AgentCardProviderError';
  }
}
