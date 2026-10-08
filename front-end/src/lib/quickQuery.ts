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
 * A submit that waited longer than this for the app to be ready is shown to
 * the user to send, not launched: an agent they no longer expect costs money.
 */
export const QUICK_QUERY_LAUNCH_WINDOW_MS = 60_000;

/**
 * The desktop launcher can submit while the main window is still being
 * (re)opened — before Terminal has mounted or its auth has resolved. Submits
 * wait here until a consumer subscribes, so none is dropped or judged early.
 */
const pendingPayloads: QuickLauncherPayload[] = [];
const consumers = new Set<QuickQueryConsumer>();

export function dispatchQuickQueryEvent(payload: QuickLauncherPayload) {
  if (typeof window === 'undefined') {
    return;
  }

  if (consumers.size === 0) {
    pendingPayloads.push(payload);
    return;
  }

  window.dispatchEvent(
    new CustomEvent<QuickLauncherPayload>(QUICK_QUERY_EVENT, { detail: payload }),
  );
}

/**
 * Receive quick-launcher submits. Subscribe only once the consumer can act on
 * one: submits held while no consumer was ready are delivered immediately.
 */
export function subscribeQuickQuery(consumer: QuickQueryConsumer): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<QuickLauncherPayload>).detail;
    if (detail) consumer(detail);
  };
  window.addEventListener(QUICK_QUERY_EVENT, listener);
  consumers.add(consumer);
  for (let held = pendingPayloads.shift(); held !== undefined; held = pendingPayloads.shift()) {
    consumer(held);
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
