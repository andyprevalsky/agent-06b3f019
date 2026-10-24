import type { QuickQueryAttachment, QuickQueryPayload } from '../../shared/types/ipc';

export function normalizeQuickQueryPayload(payload: unknown): QuickQueryPayload {
  if (typeof payload === 'string') {
    return { query: payload, submittedAt: Date.now() };
  }

  if (payload !== null && typeof payload === 'object') {
    const maybePayload = payload as Record<string, unknown>;
    const attachments = normalizeAttachments(maybePayload.attachments);
    return {
      query: typeof maybePayload.query === 'string' ? maybePayload.query : '',
      // The consumer expires a submit by its age, so the timestamp must be finite.
      submittedAt:
        typeof maybePayload.submittedAt === 'number' && Number.isFinite(maybePayload.submittedAt)
          ? maybePayload.submittedAt
          : Date.now(),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  return { query: '', submittedAt: Date.now() };
}

function normalizeAttachments(value: unknown): QuickQueryAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: QuickQueryAttachment[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    const mimeType =
      typeof record.mimeType === 'string' ? record.mimeType : 'application/octet-stream';
    const size = typeof record.size === 'number' ? record.size : 0;
    const data = toArrayBuffer(record.data);
    if (name === '' || data === null || data.byteLength === 0) continue;
    attachments.push({
      name,
      mimeType,
      size: size > 0 ? size : data.byteLength,
      data,
      ...(record.autoCaptured === true ? { autoCaptured: true } : {}),
    });
  }
  return attachments;
}

function toArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  return null;
}
