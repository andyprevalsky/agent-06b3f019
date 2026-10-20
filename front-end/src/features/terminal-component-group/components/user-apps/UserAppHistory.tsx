/**
 * STATE MACHINE: UserAppHistory (History tab of the full-screen app view)
 *
 *   [LOADING] --GET /api/user-ui/versions--> [LIST] | [ERROR "History unavailable"]
 *   [LIST] rows = versions whose manifest lists this app (Rose: every version of
 *          the user's Rose UI), newest first; the current version is semibold
 *          and labelled "Current", the others offer "Restore"
 *   [LIST] --Restore (one click)--> [RESTORING id]
 *          --POST /versions/:id/activate ok--> onRestored(id): the Apps list and the
 *            active UI refetch once, the view switches to Preview and the frame reloads
 *          --fails--> [LIST + inline error]
 *
 * One versions read per tab open; nothing is polled.
 */
import { useEffect, useState } from 'react';

import {
  activateUserUiVersion,
  fetchUserUiVersionsWithApps,
  type UserUiVersionWithApps,
} from '@/lib/api/userApps';
import { cn } from '@/lib/utils';

import { ROSE_ACTIVE_COLOR } from '../rose-sidebar/roseSidebarLayout';
import type { AppHistoryScope } from './userAppsState';

type HistoryState =
  | { kind: 'loading' }
  | { kind: 'list'; versions: UserUiVersionWithApps[] }
  | { kind: 'error' };

const MUTED = 'text-[hsl(240_6%_58%)] dark:text-[#a3a39d]';

function inScope(version: UserUiVersionWithApps, scope: AppHistoryScope): boolean {
  if (scope === null) return false;
  return scope.kind === 'all' || scope.slug in version.apps;
}

function formatWhen(iso: string | null): string {
  if (iso === null) return 'Unknown time';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** One GET per mount (the tab remounts on each open); filtered at render time. */
function useVersions(scope: AppHistoryScope): HistoryState {
  const [state, setState] = useState<HistoryState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    fetchUserUiVersionsWithApps().then(
      (versions) => {
        if (!cancelled) setState({ kind: 'list', versions });
      },
      () => {
        if (!cancelled) setState({ kind: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return state.kind === 'list'
    ? { kind: 'list', versions: state.versions.filter((v) => inScope(v, scope)) }
    : state;
}

function VersionRow({
  version,
  busy,
  onRestore,
}: {
  version: UserUiVersionWithApps;
  busy: boolean;
  onRestore: () => void;
}) {
  return (
    <li
      data-testid={`user-app-version-${version.versionId}`}
      data-current={version.active}
      className={cn(
        'flex items-center gap-4 border-b border-gray-200/80 py-3 text-[13.5px] dark:border-white/[0.09]',
        version.active ? 'font-semibold text-foreground dark:text-[#ecece8]' : MUTED,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{formatWhen(version.createdAt)}</span>
      {version.fileCount !== null && <span className="text-[12px]">{version.fileCount} files</span>}
      {version.active ? (
        <span className="text-[12.5px]">Current</span>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={onRestore}
          aria-label={`Restore version from ${formatWhen(version.createdAt)}`}
          className="text-[12.5px] font-semibold hover:underline disabled:opacity-50"
          style={{ color: ROSE_ACTIVE_COLOR }}
        >
          Restore
        </button>
      )}
    </li>
  );
}

export function UserAppHistory({
  scope,
  onRestored,
}: {
  scope: AppHistoryScope;
  onRestored: (versionId: string) => void;
}) {
  const state = useVersions(scope);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restore = (versionId: string) => {
    setRestoring(versionId);
    setError(null);
    activateUserUiVersion(versionId).then(
      () => onRestored(versionId),
      () => {
        setRestoring(null);
        setError("Couldn't restore that version. Try again.");
      },
    );
  };
  if (state.kind === 'loading') return null;
  return (
    <div data-testid="user-app-history" className="h-full overflow-auto px-8 pb-48 pt-6">
      <div className="mx-auto max-w-2xl">
        {state.kind === 'error' && <p className={MUTED}>History unavailable</p>}
        {state.kind === 'list' && state.versions.length === 0 && (
          <p className={MUTED}>No published versions yet</p>
        )}
        {error !== null && (
          <p role="alert" className="pb-2 text-[13px] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        {state.kind === 'list' && (
          <ul>
            {state.versions.map((version) => (
              <VersionRow
                key={version.versionId}
                version={version}
                busy={restoring !== null}
                onRestore={() => restore(version.versionId)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
