export const QUICK_QUERY_EVENT = 'rose:quick-query';

/** File bytes carried with a quick-query submit (uploaded before createAgent). */
export interface QuickLauncherAttachment {
  name: string;
  mimeType: string;
  size: number;
  /** Raw file bytes — structured-clone / Electron-IPC safe. */
  data: ArrayBuffer;
}

export interface QuickLauncherPayload {
  query: string;
  submittedAt: number;
  /** Optional local files; consumer uploads these before createAgent. */
  attachments?: QuickLauncherAttachment[];
}

type QuickQueryConsumer = (payload: QuickLauncherPayload) => void;

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
/** Claims settle one at a time, so claimed submits reach the consumer in submit order. */
let claiming: Promise<void> = Promise.resolve();

function hold(held: HeldQuickQuery): void {
  heldQueries.push(held);
  if (heldQueries.length > QUICK_QUERY_MAX_HELD) {
    heldQueries.shift();
    console.warn('[QuickQuery] Oldest held submit let go - nothing was ready to take it');
  }
}

function emit(payload: QuickLauncherPayload): void {
  // The consumer can go away while a claim is in flight; the submit is ours by then.
  if (consumers.size === 0) {
    hold({ payload });
    return;
  }
  window.dispatchEvent(
    new CustomEvent<QuickLauncherPayload>(QUICK_QUERY_EVENT, { detail: payload }),
  );
}

function deliver({ payload, claim }: HeldQuickQuery): void {
  if (claim === undefined) {
    emit(payload);
    return;
  }
  claiming = claiming
    .then(async () => {
      const claimed = await claim().catch(() => false);
      if (claimed) emit(payload);
    })
    .catch((error: unknown) => {
      console.error('[QuickQuery] Failed to deliver a claimed submit', error);
    });
}

export function dispatchQuickQueryEvent(payload: QuickLauncherPayload, claim?: QuickQueryClaim) {
  if (typeof window === 'undefined') {
    return;
  }

  if (consumers.size === 0) {
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
    if (detail) consumer(detail);
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
