/**
 * Cooperative time slicing for heavy work on the Electron main process.
 *
 * The main process also owns the macOS event loop for every window. One long
 * synchronous task there (decoding a large Chrome IndexedDB, or stringifying
 * its tens-of-MB upload payload) freezes the whole app with the spinning
 * beachball. Loops call `shouldYield()` per unit of work and
 * `await yieldToEventLoop()` once the slice has used its budget, so no slice
 * holds the event loop much longer than the budget.
 */

/** Longest a single slice may run before handing the event loop back. */
export const SLICE_BUDGET_MS = 8;

export class SliceClock {
  private sliceStart = performance.now();

  constructor(private readonly budgetMs: number = SLICE_BUDGET_MS) {}

  /** True once the current slice has used its budget. */
  shouldYield(): boolean {
    return performance.now() - this.sliceStart >= this.budgetMs;
  }

  /** Let pending timers, IPC and input run, then start a new slice. */
  async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.sliceStart = performance.now();
  }

  /** Yield only when the slice budget is used up. */
  async checkpoint(): Promise<void> {
    if (this.shouldYield()) await this.yieldToEventLoop();
  }
}

/** Values JSON.stringify drops from objects and turns into `null` inside arrays. */
function isUnserializable(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

/** Apply `toJSON(key)` the way JSON.stringify does (Dates, custom serializers). */
function resolveToJson(value: unknown, key: string): unknown {
  if (typeof value === 'object' && value !== null) {
    const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') return (toJSON as (k: string) => unknown).call(value, key);
  }
  return value;
}

/** Boxed primitives serialize as their primitive value. */
function isBoxedPrimitive(value: object): boolean {
  return value instanceof Number || value instanceof String || value instanceof Boolean;
}

/** Fragments joined + UTF-8 encoded per flush, keeping each join small. */
const FLUSH_PARTS = 4096;

/**
 * Produce the UTF-8 bytes of exactly `JSON.stringify(value)`, descending into
 * arrays and objects in time slices instead of one main-thread task, and
 * encoding in bounded chunks (one giant string join of a 70 MB payload alone
 * stalls the loop for 100+ ms). Every array element and object property is a
 * checkpoint; `toJSON(key)` is applied with the same key JSON.stringify uses.
 * A single huge string remains one indivisible unit.
 */
export async function jsonToBufferSliced(
  value: unknown,
  clock: SliceClock = new SliceClock()
): Promise<Buffer> {
  let parts: string[] = [];
  const chunks: Buffer[] = [];
  const flush = (): void => {
    chunks.push(Buffer.from(parts.join(''), 'utf8'));
    parts = [];
  };
  const checkpoint = async (): Promise<void> => {
    if (parts.length >= FLUSH_PARTS) flush();
    if (clock.shouldYield()) await clock.yieldToEventLoop();
  };

  /** Write an already `toJSON`-resolved, serializable value. */
  const write = async (node: unknown): Promise<void> => {
    if (typeof node !== 'object' || node === null || isBoxedPrimitive(node)) {
      parts.push(JSON.stringify(node));
      return;
    }
    if (Array.isArray(node)) {
      parts.push('[');
      for (let i = 0; i < node.length; i++) {
        if (i > 0) parts.push(',');
        const item = resolveToJson(node[i], String(i));
        if (isUnserializable(item)) parts.push('null');
        else await write(item);
        await checkpoint();
      }
      parts.push(']');
      return;
    }
    parts.push('{');
    let first = true;
    for (const key of Object.keys(node)) {
      const item = resolveToJson((node as Record<string, unknown>)[key], key);
      if (isUnserializable(item)) continue;
      if (!first) parts.push(',');
      first = false;
      parts.push(`${JSON.stringify(key)}:`);
      await write(item);
      await checkpoint();
    }
    parts.push('}');
  };

  const root = resolveToJson(value, '');
  if (!isUnserializable(root)) await write(root);
  flush();
  return Buffer.concat(chunks);
}
