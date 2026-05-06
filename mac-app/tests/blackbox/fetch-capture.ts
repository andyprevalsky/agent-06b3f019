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

function escapeMultipartValue(value: string): string {
  return value.replace(/\r?\n/g, '\r\n');
}

function serializeFormData(formData: FormData): { body: string; contentType: string } {
  const boundary = `----rose-test-boundary-${Math.random().toString(16).slice(2)}`;
  const chunks: string[] = [];

  for (const [name, value] of formData.entries()) {
    chunks.push(`--${boundary}\r\n`);
    chunks.push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    chunks.push(escapeMultipartValue(String(value)));
    chunks.push('\r\n');
  }

  chunks.push(`--${boundary}--\r\n`);

  return {
    body: chunks.join(''),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export function clearFetchCaptures(): void {
  fetchCaptures.length = 0;
  counter = 0;
}

export function installFetchCapture(responders: Record<string, MockResponder> = {}): () => void {
  const originalFetch = globalThis.fetch;

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // The Request constructor accepts Request | string | URL as `input` and
    // correctly applies `init` overrides over a source Request's defaults, so
    // we use it unconditionally rather than branching on `instanceof Request`.
    const request = new Request(input, init);
    const url = request.url;
    const method = request.method;

    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k] = v;
    });

    let body: string | null = null;
    if (init?.body instanceof FormData) {
      const serialized = serializeFormData(init.body);
      body = serialized.body;
      headers['content-type'] = serialized.contentType;
    } else {
      try {
        const cloned = request.clone();
        const text = await cloned.text();
        body = text.length > 0 ? text : null;
      } catch {
        body = null;
      }
    }

    const matchedKey = Object.keys(responders).find((pattern) => url.includes(pattern));
    const responder = matchedKey ? responders[matchedKey] : null;
    const response = responder
      ? await responder(request)
      : new Response(JSON.stringify({ error: 'unhandled request' }), { status: 501 });

    fetchCaptures.push({
      id: ++counter,
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
