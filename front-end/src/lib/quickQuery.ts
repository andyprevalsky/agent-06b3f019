export const QUICK_QUERY_EVENT = 'rose:quick-query';

/** File bytes carried with a quick-query submit (uploaded before createAgent). */
export interface QuickLauncherAttachment {
  name: string;
  mimeType: string;
  size: number;
  /** Raw file bytes — structured-clone / Electron-IPC safe. */
  data: ArrayBuffer;
  /** The screenshot the launcher captured on open, not a file the user chose. */
  autoCaptured?: boolean;
}

export interface QuickLauncherPayload {
  query: string;
  submittedAt: number;
  /** Optional local files; consumer uploads these before createAgent. */
  attachments?: QuickLauncherAttachment[];
}

/**
 * A consumer may return a promise for the work it started. The next submit is
 * claimed only after that work settles, so a submit that is still waiting its
 * turn stays with the desktop main process and survives a reload or a close.
 */
type QuickQueryConsumer = (payload: QuickLauncherPayload) => unknown;

/**
 * Resolves true once this submit is the caller's to act on. The desktop main
 * process keeps a launcher submit until it is claimed, so the claim is made
 * only when a consumer can act: a renderer that reloads first loses nothing.
 */
export type QuickQueryClaim = () => Promise<boolean>;

interface HeldQuickQuery {
  payload: QuickLauncherPayload;
  /** Absent once claimed, and for submits that need no claim. */
  claim?: QuickQueryClaim;
}

/**
 * A submit that waited longer than this for the app to be ready is shown to
 * the user to send, not launched: an agent they no longer expect costs money.
 */
export const QUICK_QUERY_LAUNCH_WINDOW_MS = 60_000;

/** How many submits wait here when nothing can take them; beyond it the oldest is let go. */
export const QUICK_QUERY_MAX_HELD = 20;

/**
 * The desktop launcher can submit while the main window is still being
 * (re)opened — before Terminal has mounted or its auth has resolved. Submits
 * wait here until a consumer subscribes, so none is dropped or judged early.
 */
const heldQueries: HeldQuickQuery[] = [];
const consumers = new Set<QuickQueryConsumer>();
/** Submits are claimed and handed over one at a time, in submit order. */
let queue: Promise<void> = Promise.resolve();
/** Submits whose claim or consumer work has not settled yet. */
let pending = 0;
/** Collects what the consumers of the submit being emitted returned. */
let emitting: Promise<unknown>[] | null = null;

function hold(held: HeldQuickQuery): void {
  heldQueries.push(held);
  if (heldQueries.length > QUICK_QUERY_MAX_HELD) {
    heldQueries.shift();
    console.warn('[QuickQuery] Oldest held submit let go - nothing was ready to take it');
  }
}

/** Hands the submit to the consumers; resolves once the work they returned has settled. */
function emit(payload: QuickLauncherPayload): Promise<void> | null {
  // The consumer can go away while a claim is in flight; the submit is ours by then.
  if (consumers.size === 0) {
    hold({ payload });
    return null;
  }
  const started: Promise<unknown>[] = [];
  emitting = started;
  try {
    window.dispatchEvent(
      new CustomEvent<QuickLauncherPayload>(QUICK_QUERY_EVENT, { detail: payload }),
    );
  } finally {
    emitting = null;
  }
  if (started.length === 0) return null;
  return Promise.allSettled(started).then(() => undefined);
}

/** Claims one submit and hands it over; it counts as pending until its consumer work settles. */
async function handOver({ payload, claim }: HeldQuickQuery): Promise<void> {
  try {
    // The consumer left while this submit waited its turn: leave it unclaimed.
    if (consumers.size === 0) {
      hold({ payload, claim });
      return;
    }
    if (claim !== undefined) {
      let claimed = false;
      try {
        claimed = await claim();
      } catch {
        claimed = false;
      }
      if (!claimed) return;
    }
    const work = emit(payload);
    if (work !== null) await work;
  } finally {
    pending -= 1;
  }
}

function deliver(held: HeldQuickQuery): void {
  if (held.claim === undefined && pending === 0) {
    const work = emit(held.payload);
    if (work === null) return;
    pending += 1;
    queue = work.then(() => {
      pending -= 1;
    });
    return;
  }
  pending += 1;
  queue = queue
    .then(() => handOver(held))
    .catch((error: unknown) => {
      console.error('[QuickQuery] Failed to deliver a submit', error);
    });
}

export function dispatchQuickQueryEvent(payload: QuickLauncherPayload, claim?: QuickQueryClaim) {
  if (typeof window === 'undefined') {
    return;
  }

  // While earlier submits are still in the queue, later ones follow them so order is kept.
  if (consumers.size === 0 && pending === 0) {
    hold({ payload, claim });
    return;
  }

  deliver({ payload, claim });
}

/**
 * Receive quick-launcher submits. Subscribe only once the consumer can act on
 * one: submits held while no consumer was ready are claimed and delivered now.
 */
export function subscribeQuickQuery(consumer: QuickQueryConsumer): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<QuickLauncherPayload>).detail;
    if (!detail) return;
    const work = consumer(detail);
    if (work instanceof Promise && emitting !== null) emitting.push(work);
  };
  window.addEventListener(QUICK_QUERY_EVENT, listener);
  consumers.add(consumer);
  for (let held = heldQueries.shift(); held !== undefined; held = heldQueries.shift()) {
    deliver(held);
  }

  return () => {
    consumers.delete(consumer);
    window.removeEventListener(QUICK_QUERY_EVENT, listener);
  };
}

/** Rebuild a browser File from an IPC-safe attachment payload. */
export function fileFromQuickLauncherAttachment(attachment: QuickLauncherAttachment): File {
  return new File([attachment.data], attachment.name, {
    type: attachment.mimeType || 'application/octet-stream',
  });
}

/** Goal text when the launcher submits files without a typed query. */
export function goalFromQuickLauncherPayload(payload: QuickLauncherPayload): string {
  const trimmed = payload.query.trim();
  if (trimmed) return trimmed;
  const files = payload.attachments ?? [];
  if (files.length === 1) return `Process ${files[0]!.name}`;
  if (files.length > 1) return `Process ${files.length} attached files`;
  return '';
}
