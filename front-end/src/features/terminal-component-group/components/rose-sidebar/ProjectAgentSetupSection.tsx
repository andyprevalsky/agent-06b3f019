/**
 * STATE MACHINE: ProjectAgentSetupSection ("Sync from your computer")
 *
 *   Project settings re-import this project from the user's Mac with no
 *   copy-paste: the Rose Mac app opens the native folder picker and runs the
 *   user's own Codex or Claude Code read-only in that folder to plan the sync,
 *   then shows the plan for approval (hooks/useLocalImport bound to this project;
 *   components/local-import/LocalImportFlow renders the states).
 *
 *   outside the Mac app (no import bridge) --> "Open the Rose Mac app…" + Download for Mac
 *   [IDLE] --Choose folder…--> picker → reading → review → syncing → done | failed
 *   [busy] --Cancel--> run cancelled, [IDLE]
 */

import { LocalImportFlow } from '@/components/local-import/LocalImportFlow';
import { hasLocalImport, useLocalImport } from '@/hooks/useLocalImport';
import { cn } from '@/lib/utils';

import { ROSE_ACTIVE_COLOR } from './roseSidebarLayout';

const MUTED = 'text-[hsl(240_8%_45%)] dark:text-[#a3a39d]';
const H3 = 'mb-2 mt-[22px] text-[13px] font-semibold';
const BUSY = new Set(['picking', 'detecting', 'scanning', 'review', 'applying']);

export function ProjectAgentSetupSection({ projectId }: { projectId: string }) {
  const flow = useLocalImport(projectId);
  const busy = BUSY.has(flow.state.status);

  if (!hasLocalImport()) {
    return (
      <section aria-label="Sync from your computer">
        <h3 className={H3}>Sync from your computer</h3>
        <p className={MUTED}>
          Open the Rose Mac app to sync this project&apos;s .env files, secrets and setup from your
          computer.{' '}
          <a href="/download" className="font-semibold" style={{ color: ROSE_ACTIVE_COLOR }}>
            Download for Mac
          </a>
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Sync from your computer">
      <div className="flex items-center justify-between gap-4">
        <h3 className={H3}>Sync from your computer</h3>
        <button
          type="button"
          onClick={() => (busy ? flow.reset() : void flow.start())}
          disabled={flow.state.status === 'picking'}
          className={cn('mt-[22px] mb-2 font-semibold disabled:opacity-40', busy && MUTED)}
          style={busy ? undefined : { color: ROSE_ACTIVE_COLOR }}
        >
          {busy ? 'Cancel' : 'Choose folder…'}
        </button>
      </div>
      {flow.state.status === 'idle' ? (
        <p className={MUTED}>
          Pick this project&apos;s folder on your Mac. Rose reads it with Codex or Claude Code and
          shows you what it will sync before anything uploads.
        </p>
      ) : (
        <LocalImportFlow flow={flow} />
      )}
    </section>
  );
}
