/**
 * STATE MACHINE: AppViewFrame (body of the full-screen app view)
 *
 *   [LOADING] status          → empty (no broken frame)
 *   [HIDDEN] 403 ROSE_DEV_ONLY → nothing at all
 *   [ERROR]                   → quiet "Preview unavailable"
 *   [READY] status paused     → quiet "Paused"
 *   [READY] not_running | unknown | no preview_url → quiet "Preview is starting…"
 *   [READY] running           → mint a handoff code (usePreviewFrameSrc):
 *       201 → <iframe> at the mint's preview_url#rose_preview_handoff=<code>
 *             (its own origin; never the app origin)
 *       409 PREVIEW_UNAVAILABLE → quiet "Preview is starting…"
 *       403 USER_SESSION_REQUIRED | ROSE_DEV_ONLY → nothing
 *       404 / other → quiet "Preview unavailable"
 * The status is read once per opened view (only the open one); nothing polls.
 */
import type { ReactNode } from 'react';

import { PREVIEW_FRAME_SANDBOX } from './appFrame';
import { appViewTitle, type AppViewTarget } from './appViewState';
import { useCodePreviewStatus, usePreviewFrameSrc } from './useAppPreview';

function QuietText({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="app-view-quiet"
      className="grid h-full w-full place-items-center text-[14px] text-[hsl(240_6%_58%)] dark:text-[#a3a39d]"
    >
      {children}
    </div>
  );
}

export function AppViewFrame({ target }: { target: AppViewTarget }) {
  const status = useCodePreviewStatus(target.taskId);
  const ready = status.kind === 'ready' ? status.view : null;
  const running = ready?.status === 'running' && ready.preview_url !== null;
  const frame = usePreviewFrameSrc(target.taskId, running);
  if (status.kind === 'loading' || status.kind === 'hidden') return null;
  if (status.kind === 'error') return <QuietText>Preview unavailable</QuietText>;
  if (ready?.status === 'paused') return <QuietText>Paused</QuietText>;
  if (!running || frame.kind === 'starting') return <QuietText>Preview is starting…</QuietText>;
  if (frame.kind === 'error') return <QuietText>Preview unavailable</QuietText>;
  if (frame.kind !== 'ready') return null;
  return (
    <iframe
      key={frame.src}
      data-testid="app-view-frame"
      src={frame.src}
      title={`${appViewTitle(target)} preview`}
      sandbox={PREVIEW_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}
