import { BACKEND_URL, DEV_LOG_ENDPOINT } from './config';

/** Posts a captured dev log entry to the backend. Silently swallows transport errors. */
export function sendDevLog(level: string, args: unknown[]): void {
  fetch(`${BACKEND_URL}${DEV_LOG_ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      args: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))),
    }),
  }).catch(() => {});
}
