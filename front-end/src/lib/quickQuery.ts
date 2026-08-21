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

export function dispatchQuickQueryEvent(payload: QuickLauncherPayload) {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<QuickLauncherPayload>(QUICK_QUERY_EVENT, { detail: payload }),
  );
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
