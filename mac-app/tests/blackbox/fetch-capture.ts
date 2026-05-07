/**
 * Node-side fetch capture for main-process domain tests.
 *
 * Renderer tests use MSW (see ./msw/capture.ts) — MSW doesn't intercept calls
 * originating from Node test code outside the DOM environment, so main-process
 * tests install this wrapper instead.
 *
 * Usage:
 *   import { installFetchCapture, clearFetchCaptures, fetchCaptures } from './fetch-capture';
 *   const restore = installFetchCapture({ '/api/agents': () => new Response(JSON.stringify({ id: '1' })) });
 *   // ... run domain code that calls fetch ...
 *   expect(fetchCaptures[0].url).toContain('/api/agents');
 *   restore();
 */

export interface FetchCapture {
  id: number;
  timestamp: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  responseStatus: number | null;
}

export type MockResponder = (req: Request) => Response | Promise<Response>;

let counter = 0;
export const fetchCaptures: FetchCapture[] = [];

export function clearFetchCaptures(): void {
  fetchCaptures.length = 0;
  counter = 0;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((v, k) => {
    result[k] = v;
  });
  return result;
}

function isFormDataBody(body: BodyInit | null | undefined): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

function serializeFormData(formData: FormData, boundary: string): string {
  const parts: string[] = [];
  for (const [key, value] of formData.entries()) {
    parts.push(`--${boundary}`);
    if (typeof value === 'string') {
      parts.push(`Content-Disposition: form-data; name="${key}"`);
      parts.push('');
      parts.push(value);
      continue;
    }
    parts.push(`Content-Disposition: form-data; name="${key}"; filename="${value.name}"`);
    parts.push(`Content-Type: ${value.type || 'application/octet-stream'}`);
    parts.push('');
    parts.push('[blob]');
  }
  parts.push(`--${boundary}--`);
  parts.push('');
  return parts.join('\r\n');
}

export function installFetchCapture(responders: Record<string, MockResponder> = {}): () => void {
  const originalFetch = globalThis.fetch;

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const id = ++counter;
    const sourceRequest = input instanceof Request ? input : null;
    const sourceHeaders = new Headers(sourceRequest?.headers);
    const initHeaders = new Headers(init?.headers);
    initHeaders.forEach((v, k) => {
      sourceHeaders.set(k, v);
    });
    let body: string | null = null;
    let request: Request;
    if (isFormDataBody(init?.body)) {
      const boundary = `----rose-test-boundary-${id}`;
      body = serializeFormData(init.body, boundary);
      sourceHeaders.set('content-type', `multipart/form-data; boundary=${boundary}`);
      request = new Request(sourceRequest?.url ?? input, {
        method: init?.method ?? sourceRequest?.method ?? 'GET',
        headers: sourceHeaders,
        body,
      });
    } else {
      request = new Request(input, init);
      try {
        const cloned = request.clone();
        const text = await cloned.text();
        body = text.length > 0 ? text : null;
      } catch {
        body = null;
      }
    }

    const url = request.url;
    const method = request.method;
    const headers = headersToRecord(request.headers);

    const matchedKey = Object.keys(responders).find((pattern) => url.includes(pattern));
    const responder = matchedKey ? responders[matchedKey] : null;
    const response = responder
      ? await responder(request)
      : new Response(JSON.stringify({ error: 'unhandled request' }), { status: 501 });

    fetchCaptures.push({
      id,
      timestamp: new Date().toISOString(),
      url,
      method,
      headers,
      body,
      responseStatus: response.status,
    });

    return response;
  };

  globalThis.fetch = mockFetch as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}
