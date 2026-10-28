import { createLogger } from '../logger';
import { retryWithBackoff } from '../retry';

const log = createLogger('CommittedMessageDelivery');

export interface BroadcastOutcome {
  ok: boolean;
  retryable: boolean;
  status: number | 'error';
}

interface Pending<T> {
  value: T;
  bytes: number;
  enqueuedAt: number;
}

interface Lane<T> {
  queue: Array<Pending<T>>;
  bytes: number;
}

interface Shard<T> {
  lanes: Map<string, Lane<T>>;
  bytes: number;
  retryActive: number;
  retryWaiters: Array<() => void>;
  settlements: Set<Promise<void>>;
}

// Admission is bounded independently of the number of agents a user owns.
// These process-local lanes recover transient sends, not process crashes.
const SHARD_COUNT = 256;
const MAX_SHARD_BYTES = 1024 * 1024;
const MAX_SHARD_LANES = 128;
const MAX_AGENT_BYTES = 256 * 1024;
const MAX_AGENT_MESSAGES = 32;
export const MAX_COMMITTED_QUEUE_AGE_MS = 30_000;
const MAX_SEND_ATTEMPTS = 3;
const MAX_SHARD_RETRIES = 4;
const MAX_INITIAL_TOPIC_MESSAGES = 64;
const MAX_INITIAL_BATCH_BYTES = 1024 * 1024;
const INITIAL_MESSAGE_OVERHEAD_BYTES = 128;

interface InitialTopic<T> {
  topic: string;
  queue: Array<{ values: T[]; bytes: number }>;
  messages: number;
  bytes: number;
  inFlight: boolean;
  ready: boolean;
  next?: InitialTopic<T>;
}

/** Batches ready topics, with one initial HTTP request per topic at a time. */
export class InitialBroadcastDispatcher<
  T extends { topic: string; payload: Record<string, unknown> },
> {
  private readonly shards = Array.from({ length: SHARD_COUNT }, () => ({
    topics: new Map<string, InitialTopic<T>>(),
    bytes: 0,
  }));
  private head?: InitialTopic<T>;
  private tail?: InitialTopic<T>;

  /**
   * `coalesce(queued, next)` may fold an ephemeral event into the topic's last
   * still-queued (unsent) entry, returning the single replacement frame. A
   * same-tick burst of stream deltas then occupies one queue slot instead of
   * one per chunk, so it cannot exhaust the per-topic message cap.
   */
  constructor(private readonly coalesce?: (queued: T, next: T) => T | undefined) {}

  enqueue(value: T): boolean {
    if (this.coalesceIntoTail(value)) return true;
    return this.enqueueGroup([value]);
  }

  private coalesceIntoTail(value: T): boolean {
    if (this.coalesce === undefined) return false;
    const shard = this.shards[topicShardIndex(value.topic)];
    const topic = shard.topics.get(value.topic);
    const last = topic?.queue[topic.queue.length - 1];
    if (topic === undefined || last === undefined || last.values.length !== 1) return false;
    const merged = this.coalesce(last.values[0], value);
    if (merged === undefined) return false;
    const bytes = initialBytes([merged]);
    const growth = bytes - last.bytes;
    if (topic.bytes + growth > MAX_AGENT_BYTES || shard.bytes + growth > MAX_SHARD_BYTES) {
      return false;
    }
    last.values[0] = merged;
    last.bytes = bytes;
    topic.bytes += growth;
    shard.bytes += growth;
    return true;
  }

  /** A committed cohort must belong to one request, including mixed batches. */
  enqueueGroup(values: T[]): boolean {
    const first = values[0];
    const bytes = initialBytes(values);
    const shard = this.shards[topicShardIndex(first.topic)];
    let topic = shard.topics.get(first.topic);
    if (
      bytes > MAX_AGENT_BYTES ||
      (topic?.bytes ?? 0) + bytes > MAX_AGENT_BYTES ||
      (topic?.messages ?? 0) + values.length > MAX_INITIAL_TOPIC_MESSAGES ||
      shard.bytes + bytes > MAX_SHARD_BYTES ||
      (topic === undefined && shard.topics.size >= MAX_SHARD_LANES)
    ) {
      log.error('Initial broadcast delivery rejected', {
        topic: first.topic,
        message_id: first.payload.id,
        reason: 'capacity',
        bytes,
      });
      return false;
    }
    if (topic === undefined) {
      topic = {
        topic: first.topic,
        queue: [],
        messages: 0,
        bytes: 0,
        inFlight: false,
        ready: false,
      };
      shard.topics.set(first.topic, topic);
    }
    topic.queue.push({ values, bytes });
    topic.messages += values.length;
    topic.bytes += bytes;
    shard.bytes += bytes;
    if (!topic.inFlight && !topic.ready) this.markReady(topic);
    return true;
  }

  hasReady(): boolean {
    return this.head !== undefined;
  }

  admissionBudget(topicName: string): { messages: number; bytes: number } {
    const shard = this.shards[topicShardIndex(topicName)];
    const topic = shard.topics.get(topicName);
    return {
      messages:
        topic === undefined && shard.topics.size >= MAX_SHARD_LANES
          ? 0
          : MAX_INITIAL_TOPIC_MESSAGES - (topic?.messages ?? 0),
      bytes: Math.min(MAX_AGENT_BYTES - (topic?.bytes ?? 0), MAX_SHARD_BYTES - shard.bytes),
    };
  }

  takeBatch(limit: number): { items: T[]; release: () => void } {
    const items: T[] = [];
    let batchBytes = 0;
    const leased: Array<{ topic: InitialTopic<T>; count: number; bytes: number }> = [];
    while (this.head !== undefined && items.length < limit) {
      const topic = this.head;
      this.head = topic.next;
      if (this.head === undefined) this.tail = undefined;
      topic.next = undefined;
      topic.ready = false;
      const entries: Array<{ values: T[]; bytes: number }> = [];
      let count = 0;
      while (
        topic.queue.length > 0 &&
        count + topic.queue[0].values.length <= limit - items.length &&
        batchBytes + topic.queue[0].bytes <= MAX_INITIAL_BATCH_BYTES
      ) {
        const entry = topic.queue.shift()!;
        entries.push(entry);
        count += entry.values.length;
        batchBytes += entry.bytes;
      }
      if (entries.length === 0) {
        this.markReady(topic);
        break;
      }
      topic.inFlight = true;
      items.push(...entries.flatMap((entry) => entry.values));
      leased.push({
        topic,
        count,
        bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      });
    }
    return {
      items,
      release: () => {
        for (const lease of leased) {
          const shard = this.shards[topicShardIndex(lease.topic.topic)];
          lease.topic.inFlight = false;
          lease.topic.messages -= lease.count;
          lease.topic.bytes -= lease.bytes;
          shard.bytes -= lease.bytes;
          if (lease.topic.queue.length === 0) shard.topics.delete(lease.topic.topic);
          else this.markReady(lease.topic);
        }
      },
    };
  }

  private markReady(topic: InitialTopic<T>): void {
    topic.ready = true;
    if (this.tail === undefined) this.head = topic;
    else this.tail.next = topic;
    this.tail = topic;
  }
}

function initialBytes(values: Array<{ topic: string; payload: Record<string, unknown> }>): number {
  return values.reduce(
    (sum, value) =>
      sum +
      Buffer.byteLength(JSON.stringify(value.payload)) +
      Buffer.byteLength(value.topic) +
      INITIAL_MESSAGE_OVERHEAD_BYTES,
    0
  );
}

/** A definite HTTP refusal of these bytes; transient statuses are retried instead. */
function isContentRejection(outcome: BroadcastOutcome): boolean {
  return (
    typeof outcome.status === 'number' &&
    outcome.status >= 400 &&
    outcome.status < 500 &&
    !outcome.retryable
  );
}

function topicShardIndex(topic: string): number {
  let hash = 0;
  for (let index = 0; index < topic.length; index += 1) {
    hash = (Math.imul(hash, 31) + topic.charCodeAt(index)) | 0;
  }
  return (hash >>> 0) % SHARD_COUNT;
}

export class CommittedMessageDelivery<
  T extends { topic: string; payload: Record<string, unknown> },
> {
  private readonly shards: Array<Shard<T>> = Array.from({ length: SHARD_COUNT }, () => ({
    lanes: new Map(),
    bytes: 0,
    retryActive: 0,
    retryWaiters: [],
    settlements: new Set(),
  }));

  constructor(
    private readonly enqueueFirst: (
      values: T[],
      enqueuedAt: number,
      settle: (outcome: BroadcastOutcome) => Promise<void>
    ) => void,
    private readonly resend: (values: T[]) => Promise<BroadcastOutcome>,
    private readonly batchLimit: number,
    private readonly firstBudget: (topic: string) => { messages: number; bytes: number },
    /**
     * Ordered substitutes for a deterministically refused INSERT, one send each:
     * the same record in another encoding, then a bounded notice to fetch it.
     */
    private readonly rejectionFallbacks: ReadonlyArray<{ name: string; map: (value: T) => T }>,
    /** Bounded stand-in for one record larger than a whole agent lane. */
    private readonly oversizeSubstitute: (value: T) => T
  ) {}

  enqueue(original: T, originalBytes: number): void {
    let value = original;
    let bytes = originalBytes;
    if (bytes > MAX_AGENT_BYTES) {
      log.error('Committed INSERT delivery rejected', {
        topic: value.topic,
        message_id: value.payload.id,
        reason: 'oversize',
        bytes,
        substitute: 'INSERT_DEFERRED',
      });
      value = this.oversizeSubstitute(value);
      bytes = Buffer.byteLength(JSON.stringify(value.payload)) + Buffer.byteLength(value.topic);
    }
    const shard = this.shards[topicShardIndex(value.topic)];
    let lane = shard.lanes.get(value.topic);
    if (
      bytes > MAX_AGENT_BYTES ||
      (lane?.bytes ?? 0) + bytes > MAX_AGENT_BYTES ||
      (lane?.queue.length ?? 0) >= MAX_AGENT_MESSAGES ||
      shard.bytes + bytes > MAX_SHARD_BYTES ||
      (lane === undefined && shard.lanes.size >= MAX_SHARD_LANES)
    ) {
      log.error('Committed INSERT delivery rejected', {
        topic: value.topic,
        message_id: value.payload.id,
        reason: 'capacity',
        bytes,
      });
      return;
    }
    if (lane === undefined) {
      lane = { queue: [], bytes: 0 };
      shard.lanes.set(value.topic, lane);
    }
    const pending = { value, bytes, enqueuedAt: Date.now() };
    lane.queue.push(pending);
    lane.bytes += bytes;
    shard.bytes += bytes;
    if (lane.queue.length === 1) this.startHead(shard, lane);
  }

  private startHead(shard: Shard<T>, lane: Lane<T>): void {
    // Keep the cohort immutable until all attempts settle. Later inserts stay
    // queued behind it, and initial admission cannot split it across requests.
    const cohort: Array<Pending<T>> = [];
    const budget = this.firstBudget(lane.queue[0].value.topic);
    let bytes = 0;
    const limit = Math.max(1, Math.min(MAX_AGENT_MESSAGES, this.batchLimit, budget.messages));
    for (const pending of lane.queue.slice(0, limit)) {
      const nextBytes = bytes + pending.bytes + INITIAL_MESSAGE_OVERHEAD_BYTES;
      if (cohort.length > 0 && nextBytes > budget.bytes) break;
      cohort.push(pending);
      bytes = nextBytes;
    }
    this.enqueueFirst(
      cohort.map((pending) => pending.value),
      cohort[0].enqueuedAt,
      (outcome) => {
        const task = this.settle(shard, lane, cohort, outcome).finally(() =>
          shard.settlements.delete(task)
        );
        shard.settlements.add(task);
        return task;
      }
    );
  }

  /** Test flush only; production dispatch never waits for unrelated lanes. */
  async waitForSettlements(): Promise<void> {
    await Promise.all(this.shards.flatMap((shard) => [...shard.settlements]));
  }

  private async settle(
    shard: Shard<T>,
    lane: Lane<T>,
    cohort: Array<Pending<T>>,
    initial: BroadcastOutcome
  ): Promise<void> {
    let attempts = 0;
    const pending = cohort[0];
    try {
      const result = await retryWithBackoff(
        async () => {
          attempts += 1;
          return attempts === 1 ? initial : this.resendBounded(shard, cohort);
        },
        {
          maxRetries: MAX_SEND_ATTEMPTS,
          initialBackoffMs: 100,
          shouldRetryResult: (outcome) =>
            !outcome.ok &&
            outcome.retryable &&
            Date.now() - pending.enqueuedAt < MAX_COMMITTED_QUEUE_AGE_MS,
          component: 'CommittedMessageDelivery',
        }
      );
      if (!result.ok && isContentRejection(result)) {
        // Resending identical bytes cannot pass a deterministic rejection such
        // as an edge WAF rule. Try each substitute frame once, in order.
        for (const fallback of this.rejectionFallbacks) {
          const outcome = await this.resendBounded(
            shard,
            cohort.map((member) => ({ ...member, value: fallback.map(member.value) }))
          );
          for (const member of cohort) {
            log.warn('Committed INSERT content rejected; sent substitute frame', {
              topic: member.value.topic,
              message_id: member.value.payload.id,
              status: result.status,
              substitute: fallback.name,
              substitute_status: outcome.status,
            });
          }
          if (outcome.ok) return;
        }
      }
      if (!result.ok) {
        for (const member of cohort) {
          log.error('Committed INSERT delivery exhausted', {
            topic: member.value.topic,
            message_id: member.value.payload.id,
            attempts,
            status: result.status,
            age_ms: Date.now() - member.enqueuedAt,
          });
        }
      }
    } catch (error) {
      for (const member of cohort) {
        log.error('Committed INSERT delivery exhausted', {
          topic: member.value.topic,
          message_id: member.value.payload.id,
          attempts,
          reason: 'unexpected_error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      for (let index = 0; index < cohort.length; index += 1) this.removeHead(shard, lane);
      while (
        lane.queue.length > 0 &&
        Date.now() - lane.queue[0].enqueuedAt >= MAX_COMMITTED_QUEUE_AGE_MS
      ) {
        log.error('Committed INSERT delivery exhausted', {
          topic: pending.value.topic,
          message_id: lane.queue[0].value.payload.id,
          attempts: 0,
          reason: 'queue_age',
        });
        this.removeHead(shard, lane);
      }
      if (lane.queue.length === 0) shard.lanes.delete(pending.value.topic);
      else this.startHead(shard, lane);
    }
  }

  private removeHead(shard: Shard<T>, lane: Lane<T>): void {
    const removed = lane.queue.shift()!;
    lane.bytes -= removed.bytes;
    shard.bytes -= removed.bytes;
  }

  private async resendBounded(
    shard: Shard<T>,
    cohort: Array<Pending<T>>
  ): Promise<BroadcastOutcome> {
    if (shard.retryActive >= MAX_SHARD_RETRIES) {
      await new Promise<void>((resolve) => shard.retryWaiters.push(resolve));
    } else {
      shard.retryActive += 1;
    }
    try {
      if (Date.now() - cohort[0].enqueuedAt >= MAX_COMMITTED_QUEUE_AGE_MS) {
        return { ok: false, retryable: false, status: 'error' };
      }
      return await this.resend(cohort.map((pending) => pending.value));
    } finally {
      const next = shard.retryWaiters.shift();
      if (next === undefined) shard.retryActive -= 1;
      else next();
    }
  }
}
