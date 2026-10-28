/**
 * Recorded outbound responses: the stored shape and its rebuild into a real
 * Response for replay.
 */
export interface SerializedResponse {
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
  /** Private capture metadata — never store this in upstream HTTP headers. */
  bodyEncoding?: 'base64';
}

/** Statuses the WHATWG Response constructor rejects with any body, even ''. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export function responseFromSerialized(serialized: SerializedResponse): globalThis.Response {
  const headers: Record<string, string> = { ...serialized.headers };
  const body = NULL_BODY_STATUSES.has(serialized.status)
    ? null
    : serialized.bodyEncoding === 'base64'
      ? Buffer.from(serialized.body, 'base64')
      : serialized.body;

  return new globalThis.Response(body, {
    status: serialized.status,
    statusText: serialized.statusText,
    headers,
  });
}
