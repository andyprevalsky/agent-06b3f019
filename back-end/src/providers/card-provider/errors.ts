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

/** A closed-card response proves unavailability, not merchant settlement. */
export function isClosedCardDetailsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.toLowerCase() === 'card_closed') return true;
  return /\bcard_closed\b/i.test(error instanceof Error ? error.message : String(error));
}
