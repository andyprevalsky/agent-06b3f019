import { MAX_RESPONSE_BODY_BYTES } from './config';
import { ExternalHttpRequestFailedError } from './errors';
import type { ExternalHttpResponseBody } from './types';

async function readBoundedResponseBuffer(response: Response): Promise<Buffer> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null && contentLengthHeader.trim() !== '') {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BODY_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new ExternalHttpRequestFailedError(
        `External HTTP response exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`,
        response.status,
        null
      );
    }
  }

  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ExternalHttpRequestFailedError(
        `External HTTP response exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`,
        response.status,
        null
      );
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export async function readResponseBody(response: Response): Promise<{
  body: unknown;
  body_encoding: ExternalHttpResponseBody['body_encoding'];
  content_type: string | null;
}> {
  const contentType = response.headers.get('content-type');
  const buffer = await readBoundedResponseBuffer(response);

  if (buffer.length === 0) {
    return { body: '', body_encoding: 'text', content_type: contentType };
  }

  const normalizedType = (contentType ?? '').toLowerCase();
  const text = buffer.toString('utf8');

  if (
    normalizedType.includes('application/json') ||
    normalizedType.includes('+json') ||
    text.trimStart().startsWith('{') ||
    text.trimStart().startsWith('[')
  ) {
    try {
      return { body: JSON.parse(text), body_encoding: 'json', content_type: contentType };
    } catch {
      return { body: text, body_encoding: 'text', content_type: contentType };
    }
  }

  if (
    normalizedType.startsWith('text/') ||
    normalizedType.includes('xml') ||
    normalizedType.includes('javascript')
  ) {
    return { body: text, body_encoding: 'text', content_type: contentType };
  }

  return {
    body: buffer.toString('base64'),
    body_encoding: 'base64',
    content_type: contentType,
  };
}
