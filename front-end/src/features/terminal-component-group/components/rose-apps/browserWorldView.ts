/**
 * Pure text for the Browser drawer's world-state lines (plan row A6). No
 * state machine; unit-tested in rose-apps-root-browser.blackbox.tsx.
 *
 *   agentSiteLines   per-site state of the agent's shown browser task:
 *                      forked          "forked github.com"
 *                      merged          "merged login for github.com"
 *                      stale           "github.com stale"              (muted)
 *                      signed_out      "signed out of github.com"      (muted)
 *                      no_login        "no login on github.com"        (muted)
 *                      no_login_signal "no login signal on github.com" (muted)
 *                      unchanged       "github.com unchanged"          (muted)
 *                    the task the tab shows wins; unknown task -> newest
 *                    entry per site across the agent's tasks
 *   receiptText      Root close receipt: "Saved logins for a.com, b.com";
 *                    nothing merged -> "Browser closed"
 *   lastWriterText   "by Root" | "by <agent title>" | "by an agent" | null
 */

import type {
  AgentBrowserTaskView,
  ForkView,
  RootSiteView,
  WorldStateMergeReceipt,
} from '@/lib/api/browser-world';

export interface SiteLine {
  site: string;
  text: string;
  muted: boolean;
}

function lineFor(fork: ForkView): SiteLine {
  const { site } = fork;
  switch (fork.state) {
    case 'forked':
      return { site, text: `forked ${site}`, muted: false };
    case 'merged':
      return { site, text: `merged login for ${site}`, muted: false };
    case 'stale':
      return { site, text: `${site} stale`, muted: true };
    case 'signed_out':
      return { site, text: `signed out of ${site}`, muted: true };
    case 'no_login':
      return { site, text: `no login on ${site}`, muted: true };
    case 'no_login_signal':
      return { site, text: `no login signal on ${site}`, muted: true };
    default:
      return { site, text: `${site} unchanged`, muted: true };
  }
}

export function agentSiteLines(tasks: AgentBrowserTaskView[], taskId: string | null): SiteLine[] {
  const shown = tasks.find((task) => task.task_id === taskId);
  const forks = shown !== undefined ? shown.sites : tasks.flatMap((task) => task.sites);
  const seen = new Set<string>();
  const lines: SiteLine[] = [];
  for (const fork of forks) {
    if (seen.has(fork.site)) continue;
    seen.add(fork.site);
    lines.push(lineFor(fork));
  }
  return lines;
}

export function receiptText(receipt: WorldStateMergeReceipt | null): string {
  const merged = (receipt?.sites ?? [])
    .filter((site) => site.outcome === 'merged')
    .map((site) => site.site);
  return merged.length === 0 ? 'Browser closed' : `Saved logins for ${merged.join(', ')}`;
}

export function lastWriterText(
  writer: RootSiteView['last_writer'],
  agentTitle: (agentId: string) => string | null,
): string | null {
  if (writer.kind === 'root') return 'by Root';
  if (writer.kind !== 'agent') return null;
  const title = writer.agent_id === null ? null : agentTitle(writer.agent_id);
  return title === null ? 'by an agent' : `by ${title}`;
}

export function cookieCountText(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'cookie' : 'cookies'}`;
}

/** "just now", "5 min ago", "3 h ago", else the local date. */
export function updatedText(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
