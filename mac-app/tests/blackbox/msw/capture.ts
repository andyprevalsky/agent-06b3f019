import { server } from './server';

export interface CapturedRequest {
  id: number;
  timestamp: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

let counter = 0;
export const capturedRequests: CapturedRequest[] = [];

export function clearCaptures(): void {
  capturedRequests.length = 0;
  counter = 0;
}

server.events.on('request:start', ({ request }) => {
  void (async () => {
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k] = v;
    });

    let body: string | null = null;
    try {
      const cloned = request.clone();
      const text = await cloned.text();
      body = text.length > 0 ? text : null;
    } catch {
      body = null;
    }

    capturedRequests.push({
      id: ++counter,
      timestamp: new Date().toISOString(),
      url: request.url,
      method: request.method,
      headers,
      body,
    });
  })();
});
