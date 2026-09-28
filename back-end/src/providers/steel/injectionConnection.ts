import { retryWithBackoff } from '../retry';

/** Retry only transport failures before any cookies or browser state are applied. */
export async function connectCredentialCdp<T>(connect: () => Promise<T>): Promise<T> {
  return retryWithBackoff(connect, {
    maxRetries: 3,
    // Keep the retry overhead below the short CDP timeout used by callers
    // that need a quick failure when the websocket never upgrades.
    fixedDelays: [50, 100],
    component: 'Steel credential CDP connection',
    isRetryable: (error) => {
      if (!(error instanceof Error)) return false;
      const message = error.message.toLowerCase();
      if (!message.includes('browsertype.connectovercdp')) return false;
      return (
        (message.includes('timeout') && message.includes('ws connecting')) ||
        message.includes('econnreset') ||
        message.includes('etimedout') ||
        message.includes('socket hang up')
      );
    },
  });
}
