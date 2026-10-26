/** Browser world domain config (plan row A6). */

/** Root cookies injected into a freshly opened Root browser, at most. */
export const MAX_ROOT_COOKIES_PER_OPEN = 5_000;

/** Browser tasks listed per agent, newest first. */
export const MAX_AGENT_BROWSER_TASKS = 50;

/** Root sites listed per request. */
export const MAX_ROOT_SITES_LISTED = 500;

/** Provider session statuses that mean the Root browser can still be shown. */
export const LIVE_PROVIDER_STATUSES = ['live', 'active', 'running'];

export function liveViewPath(taskId: string): string {
  return `/api/browser-session/task/${taskId}/live-view`;
}

export function controlPath(taskId: string): string {
  return `/api/browser-session/task/${taskId}/control`;
}
