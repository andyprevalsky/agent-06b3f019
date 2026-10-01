/** The Gmail boundary trace needs status and IDs, never the RFC 5322 body. */
export function redactGmailArchive(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const request = (record.request ?? {}) as Record<string, unknown>;
  const response = (record.response ?? {}) as Record<string, unknown>;
  const context = (record.context ?? {}) as Record<string, unknown>;
  return {
    provider: 'gmail',
    request: { method: request.method, url: request.url },
    response: { id: response.id, threadId: response.threadId },
    status_code: record.status_code,
    success: record.success,
    context: {
      user_id: context.user_id,
      agent_id: context.agent_id,
      message_id: context.message_id,
      thread_id: context.thread_id,
    },
  };
}
