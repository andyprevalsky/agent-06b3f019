/**
 * Transactional overlap for speculative chat generation.
 *
 *   Router START ──> STARTED ──> provider/cache work ──> buffered stream frames
 *                         │                                  │
 *   Router commit ────────┴─ direct_answer ──> COMMIT ──────┴─> ordered delivery
 *                         └─ non-direct/error ──> ABORT + DISCARD (no side effects)
 *
 * The gate is deliberately independent of Router timing so other speculative
 * triggers can reuse the same commit/abort safety boundary.
 */

type BufferedDelivery = () => Promise<void>;

export interface TransactionalStreamGate {
  emit(delivery: BufferedDelivery): Promise<void>;
  waitForCommit(): Promise<boolean>;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

interface EarlyDirectGeneratorStartContext {
  abortSignal: AbortSignal;
  streamGate: TransactionalStreamGate;
}

interface EarlyDirectGeneratorCoordinatorOptions<T> {
  start: (context: EarlyDirectGeneratorStartContext) => Promise<T>;
}

interface SettledGenerator<T> {
  status: 'fulfilled' | 'rejected';
  value?: T;
  reason?: unknown;
}

interface SpeculativeChatMessage {
  role: string;
  text: string;
}

const NON_DIRECT_INTENT =
  /\b(?:search\s+(?:the\s+)?web|browse\s+(?:the\s+)?web|look\s+up|latest|today(?:'s)?|current\s+(?:news|events?|prices?)|research|autonomous\s+agent|agent\s+mode|plan\s+mode|execute\s+mode)\b/i;

export interface EarlyDirectGeneratorCoordinator<T> {
  start(): void;
  commitDirectAnswer(): Promise<T | null>;
  discard(): Promise<void>;
}

/**
 * Avoid spending a speculative Generator slot on an obviously non-direct turn.
 *
 * This is only a load-shedding hint: the Router remains authoritative, and a
 * false negative merely starts the canonical Generator after routing. Keeping
 * web/agent turns out of the speculative lane prevents their discarded calls
 * from starving the latency-sensitive Router under concurrent chat load.
 */
export function shouldStartEarlyDirectGenerator(
  messages: readonly SpeculativeChatMessage[]
): boolean {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'USER');
  if (!latestUserMessage?.text.trim()) return false;
  return !NON_DIRECT_INTENT.test(latestUserMessage.text);
}

export function createTransactionalStreamGate(): TransactionalStreamGate {
  let state: 'pending' | 'committed' | 'discarded' = 'pending';
  const buffered: BufferedDelivery[] = [];
  let deliveryChain = Promise.resolve();
  let resolveDecision!: (committed: boolean) => void;
  const decision = new Promise<boolean>((resolve) => {
    resolveDecision = resolve;
  });

  return {
    async emit(delivery): Promise<void> {
      if (state === 'discarded') return;
      if (state === 'pending') {
        buffered.push(delivery);
        return;
      }
      deliveryChain = deliveryChain.then(delivery);
      await deliveryChain;
    },
    async waitForCommit(): Promise<boolean> {
      const committed = await decision;
      if (committed) await deliveryChain;
      return committed;
    },
    async commit(): Promise<void> {
      if (state !== 'pending') return;
      state = 'committed';
      for (const delivery of buffered.splice(0)) {
        deliveryChain = deliveryChain.then(delivery);
      }
      resolveDecision(true);
      await deliveryChain;
    },
    async discard(): Promise<void> {
      if (state !== 'pending') return;
      state = 'discarded';
      buffered.length = 0;
      resolveDecision(false);
    },
  };
}

export async function runAfterStreamCommit(
  streamGate: TransactionalStreamGate | undefined,
  operation: () => Promise<void>
): Promise<boolean> {
  if (streamGate && !(await streamGate.waitForCommit())) return false;
  await operation();
  return true;
}

export function createEarlyDirectGeneratorCoordinator<T>(
  options: EarlyDirectGeneratorCoordinatorOptions<T>
): EarlyDirectGeneratorCoordinator<T> {
  const abortController = new AbortController();
  const streamGate = createTransactionalStreamGate();
  let outcome: Promise<SettledGenerator<T>> | null = null;
  let explicitlyDiscarded = false;

  return {
    start(): void {
      if (outcome) return;
      let started: Promise<T>;
      try {
        started = options.start({
          abortSignal: abortController.signal,
          streamGate,
        });
      } catch (error) {
        started = Promise.reject(error);
      }
      outcome = started.then(
        (value): SettledGenerator<T> => ({ status: 'fulfilled', value }),
        (reason: unknown): SettledGenerator<T> => {
          void streamGate.discard();
          return { status: 'rejected', reason };
        }
      );
    },
    async commitDirectAnswer(): Promise<T | null> {
      if (!outcome || explicitlyDiscarded) return null;
      await streamGate.commit();
      const settled = await outcome;
      if (settled.status === 'rejected') throw settled.reason;
      return settled.value as T;
    },
    async discard(): Promise<void> {
      explicitlyDiscarded = true;
      abortController.abort();
      await streamGate.discard();
      if (outcome) await outcome;
    },
  };
}
