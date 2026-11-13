/**
 * MSW request capture module for blackbox tests.
 * Records every API request intercepted by MSW for assertion in tests.
 */

import type { SetupServer } from 'msw/node';

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  timestamp: string;
}

export const capturedRequests: CapturedRequest[] = [];
let captureEpoch = 0;

export function clearCaptures(): void {
  captureEpoch += 1;
  capturedRequests.length = 0;
}

/**
 * Install capture listener on the MSW server.
 * Call this in the test setup file.
 */
export function installCapture(server: Pick<SetupServer, 'events'>): void {
  server.events.on('request:start', async ({ request }) => {
    // Only capture API requests, not static assets
    if (!request.url.includes('/api/')) return;
    const epoch = captureEpoch;

    let body: unknown = null;
    try {
      const cloned = request.clone();
      const text = await cloned.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
    } catch {
      // Body not readable
    }

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    if (epoch !== captureEpoch) return;
    capturedRequests.push({
      url: request.url,
      method: request.method,
      headers,
      body,
      timestamp: new Date().toISOString(),
    });
  });
}
